"""Image to 3D: Idol (speridlabs/idol, Apache 2.0) turns one photo into an object made of Gaussian splats, on this
machine, and the page shows it in 3D.

Idol needs PyTorch, so it runs in its own environment (examples/image-to-3d/.venv) as a subprocess, as the LoRA page
runs its training. The script writes one JSON line per stage; this service passes them to the page as a stream. One
run at a time: a second would share the same GPU memory. It costs nothing, so there is no budget guard.

Each result is a folder under generated/image-to-3d/: the photo as sent, the image Idol saw (background removed), the
splats as a standard .ply, the camera it predicted, and result.json with the settings and timings.
"""
from __future__ import annotations

import json
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Iterator

from ..core.child_env import HF, child_env
from ..core.errors import ApiError
from ..shared import ROOT
from .runs import Run, RunStreamer

FOLDER = ROOT / "examples" / "image-to-3d"
SETUP = "cd examples/image-to-3d && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt"
GATED = [
    {"repo": "facebook/dinov3-vith16plus-pretrain-lvd1689m", "what": "DINOv3, the image encoder"},
    {"repo": "black-forest-labs/FLUX.2-dev", "what": "FLUX.2's autoencoder"},
]
RUN_TIMEOUT_S = 3600  # the defaults take about 18 minutes on a MacBook Air
MAX_IMAGE_BYTES = 15 * 2**20
GAUSSIANS = (32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576)
MODES = ("real", "synthetic")
PASSED_ON = ("progress", "setup")  # what the script may say to the page; its result and errors are read here
BUSY = "An object is already being made. Wait for it, or cancel it."
RESULT_ID = re.compile(r"^[0-9a-f]{12}$")
FILES = {"object.ply": "application/octet-stream", "input.png": "image/png", "camera.json": "application/json"}
IMAGE_TYPES = {b"\x89PNG\r\n\x1a\n": "png", b"\xff\xd8\xff": "jpg", b"RIFF": "webp"}
# Published by Speridlabs (github.com/speridlabs/idol-sdk), for setting expectations: the page labels them as theirs.
TIMINGS = [
    {"where": "MacBook Air (M4), MPS", "setting": "10 steps, 65,536 Gaussians", "time": "about 4 min"},
    {"where": "MacBook Air (M4), MPS", "setting": "50 steps, 262,144 Gaussians (needs 24 GB)", "time": "about 18 min"},
    {"where": "RTX 4090", "setting": "50 steps, 262,144 Gaussians", "time": "19.1 s"},
    {"where": "H100", "setting": "50 steps, 262,144 Gaussians", "time": "6.7 s"},
]

Runner = Callable[[list[str], str, Callable[[dict], None], threading.Event, float], int]


def subprocess_runner(argv: list[str], job: str, on_line: Callable[[dict], None], cancelled: threading.Event,
                      timeout_s: float) -> int:
    """Runs the script with the job on stdin and passes each JSON line on. Cancelling or the time limit kills it."""
    proc = subprocess.Popen(argv, cwd=FOLDER, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, bufsize=1, env=child_env(*HF))  # third-party packages: none of our keys
    deadline = time.monotonic() + timeout_s
    timed_out = threading.Event()

    def watch() -> None:
        while proc.poll() is None:
            if cancelled.wait(0.5) or time.monotonic() > deadline:
                if not cancelled.is_set():
                    timed_out.set()
                proc.kill()
                return

    threading.Thread(target=watch, daemon=True).start()
    assert proc.stdin and proc.stdout
    try:
        proc.stdin.write(job)
        proc.stdin.close()
    except BrokenPipeError:  # already gone: cancelled at once, or it failed on start; the exit code says which
        pass
    for line in proc.stdout:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue  # progress bars and warnings from the libraries
        if isinstance(event, dict):
            on_line(event)
    code = proc.wait()
    if timed_out.is_set():  # otherwise a slow run reads like a crash
        on_line({"type": "error", "message": f"Stopped at the {timeout_s / 60:.0f}-minute time limit. Try fewer steps "
                                            "or fewer Gaussians."})
    return code


def image_type(data: bytes) -> str | None:
    """png, jpg or webp from the file's first bytes, or None. The name and the browser's label are not trusted."""
    for magic, kind in IMAGE_TYPES.items():
        if data.startswith(magic) and (kind != "webp" or data[8:12] == b"WEBP"):
            return kind
    return None


class ImageTo3DService:
    def __init__(self, root: Path, streamer: RunStreamer | None = None, venv_python: Path | None = None,
                 runner: Runner | None = None):
        self.root, self.streamer = root, streamer
        self.python = venv_python or FOLDER / ".venv" / "bin" / "python"
        self.script = FOLDER / "run_idol.py"
        self.runner = runner or subprocess_runner
        self._busy = threading.Lock()
        self._current: Run | None = None

    def info(self) -> dict[str, Any]:
        apple = sys.platform == "darwin" and platform.machine() == "arm64"
        return {
            "ready": self.python.exists(), "setup": SETUP, "busy": self._busy.locked(), "gated": GATED,
            "machine": "Apple silicon (Idol runs on its GPU through MPS, without the CUDA-only speed-ups)" if apple
                       else platform.machine(),
            # On a Mac the defaults take about 18 minutes and 24 GB, so the page starts smaller.
            "defaults": {"mode": "real", "seed": 42, "steps": 20 if apple else 50,
                         "num_gaussians": 65_536 if apple else 262_144},
            "limits": {"gaussians": list(GAUSSIANS), "steps": [5, 100], "image_bytes": MAX_IMAGE_BYTES},
            "timings": TIMINGS, "results": self.results(),
        }

    def results(self) -> list[dict[str, Any]]:
        """Saved objects, newest first."""
        out = []
        if not self.root.exists():
            return out
        for folder in self.root.iterdir():
            meta = folder / "result.json"
            if not RESULT_ID.match(folder.name):
                continue
            try:
                out.append({**json.loads(meta.read_text()), "id": folder.name, "created": meta.stat().st_mtime})
            except (OSError, ValueError, TypeError):  # missing, half written, deleted meanwhile or edited by hand
                continue
        return sorted(out, key=lambda r: -r["created"])

    def file(self, result_id: str, name: str) -> tuple[Path, str]:
        """One of a result's files and its media type. Only the names Idol writes, in a folder that exists."""
        if name not in FILES:
            raise ApiError(404, "not_found", "No such file.")
        path = self._result(result_id) / name
        if not path.is_file():
            raise ApiError(404, "not_found", "No such file.")
        return path, FILES[name]

    def remove(self, result_id: str) -> dict[str, Any]:
        shutil.rmtree(self._result(result_id))
        return {"deleted": result_id}

    def _result(self, result_id: str) -> Path:
        folder = self.root / result_id
        if not RESULT_ID.match(result_id or "") or not (folder / "result.json").exists():
            raise ApiError(404, "not_found", "That object has gone.")
        return folder

    def generate(self, image: bytes, settings: dict[str, Any]) -> Iterator[str]:
        """One photo to a 3D object, streamed: progress, the device, then the result (or an error)."""
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        if not self.python.exists():
            raise ApiError(503, "not_installed", f"Idol is not installed. From the repo root run: {SETUP}")
        if len(image) > MAX_IMAGE_BYTES:
            raise ApiError(413, "too_large", f"The image is over {MAX_IMAGE_BYTES // 2**20} MB.")
        kind = image_type(image)
        if kind is None:
            raise ApiError(400, "invalid_request", "Send a PNG, JPEG or WebP photo.")
        if settings["num_gaussians"] not in GAUSSIANS:
            raise ApiError(400, "invalid_request", f"Gaussians must be one of: {', '.join(map(str, GAUSSIANS))}.")
        if self._busy.locked():  # a quick answer; the lock itself is taken by the work, below
            raise ApiError(409, "busy", BUSY)
        run = Run()
        result_id = uuid.uuid4().hex[:12]
        out_dir = self.root / result_id
        source = out_dir / f"source.{kind}"
        job = json.dumps({**settings, "image": str(source), "out_dir": str(out_dir)})

        def work() -> None:
            # Taken here, not before streaming: the stream starts its work only when the response is first read, so a
            # page gone before that would have left the lock held, and every later request refused, until a restart.
            if not self._busy.acquire(blocking=False):
                run.publish({"type": "error", "message": BUSY})
                return
            self._current = run
            got: dict[str, Any] = {}
            saved = False
            try:
                out_dir.mkdir(parents=True, exist_ok=True)
                source.write_bytes(image)
                run.publish({"type": "progress", "step": "Starting Idol's environment", "elapsed_s": 0})

                def on_line(event: dict) -> None:
                    if event.get("type") in ("result", "error"):
                        got.update(event)
                    elif event.get("type") in PASSED_ON:  # a stray JSON line from a library never reaches the page
                        run.publish(event)

                try:
                    code = self.runner([str(self.python), str(self.script)], job, on_line, run.cancelled, RUN_TIMEOUT_S)
                except OSError as exc:
                    run.publish({"type": "error", "message": f"Could not start Idol's environment: {exc}"})
                    return
                if run.cancelled.is_set():
                    run.publish({"type": "error", "message": "Cancelled. Nothing was saved."})
                elif got.get("type") != "result" or not (out_dir / "object.ply").is_file():
                    run.publish({"type": "error", "message": got.get("message")
                                 or f"Idol stopped (exit code {code}). Run examples/image-to-3d/run_idol.py by hand to "
                                    "see why."})
                else:
                    meta = {"settings": settings, "source": source.name,
                            **{k: got[k] for k in ("device", "load_s", "generate_s", "total_s", "ply_bytes", "camera")
                               if k in got}}
                    partial = out_dir / "result.json.part"
                    partial.write_text(json.dumps(meta))
                    partial.replace(out_dir / "result.json")  # whole or absent: results() never reads half of it
                    saved = True
                    run.publish({"type": "done", "result": {"id": result_id, "created": time.time(), **meta}})
            finally:
                if not saved:  # failed, cancelled or interrupted: leave no half-made folder behind
                    shutil.rmtree(out_dir, ignore_errors=True)
                self._current = None
                self._busy.release()

        return self.streamer.lines(run, work)

    def cancel(self) -> dict[str, Any]:
        run = self._current
        if run is None:
            return {"cancelled": False}
        run.cancel()
        return {"cancelled": True}
