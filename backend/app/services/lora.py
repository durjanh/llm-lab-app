"""Fine-tuning with LoRA: a small open model learns a fixed JSON format from a few hundred invented emails, on this
machine, and code scores it before and after on emails it never saw.

Training needs PyTorch, so it runs in its own environment (examples/lora/.venv) as a subprocess, as the tabular page
runs TabPFN. The script writes one JSON line per event (progress, each step's loss, the scores); this service passes
them to the page as a stream. One run at a time: a second would share the same GPU memory. Training costs nothing.

The task, the scoring and the memory arithmetic live in examples/lora/lora_data.py, plain Python, loaded here too.
"""
from __future__ import annotations

import importlib.util
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

from ..core.errors import ApiError
from ..shared import ROOT
from .runs import Run, RunStreamer

FOLDER = ROOT / "examples" / "lora"
SETUP = "cd examples/lora && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt"
RUN_TIMEOUT_S = 1200
TRY_TIMEOUT_S = 180
MODELS = {
    "HuggingFaceTB/SmolLM2-135M-Instruct": "SmolLM2 135M Instruct (Apache 2.0, 270 MB)",
    "HuggingFaceTB/SmolLM2-360M-Instruct": "SmolLM2 360M Instruct (Apache 2.0, 720 MB)",
}
ADAPTER_ID = re.compile(r"^[0-9a-f]{12}$")

Runner = Callable[[list[str], str, Callable[[dict], None], threading.Event, float], int]


def _load_data() -> Any:
    """examples/lora/lora_data.py, the task and scoring shared with the training script."""
    name = "_lora_data"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, FOLDER / "lora_data.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


data = _load_data()


def subprocess_runner(argv: list[str], job: str, on_line: Callable[[dict], None], cancelled: threading.Event,
                      timeout_s: float) -> int:
    """Runs the script, feeding it the job and passing each JSON line on. Cancelling or the time limit kills it."""
    proc = subprocess.Popen(argv, cwd=FOLDER, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1)
    deadline = time.monotonic() + timeout_s

    def watch() -> None:
        while proc.poll() is None:
            if cancelled.wait(0.5) or time.monotonic() > deadline:
                proc.kill()
                return

    threading.Thread(target=watch, daemon=True).start()
    assert proc.stdin and proc.stdout
    proc.stdin.write(job)
    proc.stdin.close()
    for line in proc.stdout:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue  # progress bars and warnings from the libraries
        if isinstance(event, dict):
            on_line(event)
    return proc.wait()


class LoraService:
    def __init__(self, root: Path, streamer: RunStreamer | None = None, venv_python: Path | None = None,
                 runner: Runner | None = None):
        self.root, self.streamer = root, streamer
        self.python = venv_python or FOLDER / ".venv" / "bin" / "python"
        self.script = FOLDER / "run_lora.py"
        self.runner = runner or subprocess_runner
        self._busy = threading.Lock()
        self._current: Run | None = None

    @property
    def adapters_dir(self) -> Path:
        return self.root / "adapters"

    @property
    def models_dir(self) -> Path:
        return self.root / "models"

    def info(self) -> dict[str, Any]:
        train, test = data.dataset()
        apple = sys.platform == "darwin" and platform.machine() == "arm64"
        return {
            "ready": self.python.exists(), "setup": SETUP, "busy": self._busy.locked(),
            "models": [{"id": k, "label": v, **{key: data.ARCHITECTURES[k][key]
                                                 for key in ("params", "hidden", "layers", "intermediate", "kv")}}
                       for k, v in MODELS.items()],
            "targets": data.TARGETS, "fields": data.FIELDS, "system": data.SYSTEM,
            "dataset": {"train": len(train), "test": len(test),
                        "examples": [{"email": e["email"], "target": e["target"]} for e in train[:3]]},
            "machine": "Apple silicon (the script trains on its GPU through MPS)" if apple else platform.machine(),
            "qlora_here": False if apple else None,  # None: the script finds out whether there is CUDA
            "memory": [data.memory(a, 16) for a in data.ARCHITECTURES.values()],
            "adapters": self.adapters(),
        }

    def adapters(self) -> list[dict[str, Any]]:
        """Saved adapters, newest first, with their settings and scores."""
        out = []
        if not self.adapters_dir.exists():
            return out
        for folder in self.adapters_dir.iterdir():
            result = folder / "result.json"
            if not (ADAPTER_ID.match(folder.name) and result.exists()):
                continue
            r = json.loads(result.read_text())
            out.append({"id": folder.name, "created": result.stat().st_mtime, "model_id": r.get("model_id"),
                        "config": r["config"], "params": r["params"], "sizes": r["sizes"], "train_s": r["train_s"],
                        "before": r["before"]["metrics"], "after": r["after"]["metrics"]})
        return sorted(out, key=lambda a: -a["created"])

    def remove(self, adapter_id: str) -> dict[str, Any]:
        folder = self._adapter(adapter_id)
        shutil.rmtree(folder)
        return {"deleted": adapter_id}

    def _adapter(self, adapter_id: str) -> Path:
        folder = self.adapters_dir / adapter_id
        if not ADAPTER_ID.match(adapter_id or "") or not (folder / "result.json").exists():
            raise ApiError(404, "not_found", "That adapter has gone.")
        return folder

    def _ready(self) -> None:
        if not self.python.exists():
            raise ApiError(503, "not_installed", f"The training environment is not installed. From the repo root run: "
                                                 f"{SETUP}")

    def train(self, config: dict[str, Any]) -> Iterator[str]:
        """A training run, streamed: progress, the scores before, each step's loss, the scores after, the result."""
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        self._ready()
        if config.get("model_id") not in MODELS:
            raise ApiError(400, "invalid_request", f"Choose one of: {', '.join(MODELS)}.")
        if not config.get("targets") or any(t not in data.TARGETS for t in config["targets"]):
            raise ApiError(400, "invalid_request", f"Target modules must come from: {', '.join(data.TARGETS)}.")
        if not self._busy.acquire(blocking=False):
            raise ApiError(409, "busy", "A training run is already going. Wait for it, or cancel it.")
        run = Run()
        self._current = run
        adapter_id = uuid.uuid4().hex[:12]
        out_dir = self.adapters_dir / adapter_id
        job = json.dumps({"action": "train", **config, "models_dir": str(self.models_dir), "out_dir": str(out_dir),
                          "eval_n": 40})

        def work() -> None:
            got: dict[str, Any] = {}
            try:
                self.models_dir.mkdir(parents=True, exist_ok=True)
                out_dir.mkdir(parents=True, exist_ok=True)
                run.publish({"type": "progress", "step": "Starting the training environment"})

                def on_line(event: dict) -> None:
                    if event.get("type") in ("result", "error"):
                        got.update(event)
                    if event.get("type") != "error":
                        run.publish(event)

                try:
                    code = self.runner([str(self.python), str(self.script)], job, on_line, run.cancelled,
                                       RUN_TIMEOUT_S)
                except OSError as exc:
                    run.publish({"type": "error", "message": f"Could not start the training environment: {exc}"})
                    return
                if run.cancelled.is_set():
                    run.publish({"type": "error", "message": "Cancelled. Nothing was saved."})
                elif got.get("type") != "result":
                    run.publish({"type": "error", "message": got.get("message")
                                 or f"Training stopped (exit code {code}). See the backend log."})
                else:
                    run.publish({"type": "done", "adapter_id": adapter_id})
            finally:
                if got.get("type") != "result":
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

    def try_email(self, email: str, adapter_id: str | None) -> dict[str, Any]:
        """The base model's answer to one email, and the adapter's, side by side."""
        self._ready()
        job: dict[str, Any] = {"action": "try", "email": email, "models_dir": str(self.models_dir), "adapter_dir": None,
                               "model_id": next(iter(MODELS))}
        if adapter_id:
            folder = self._adapter(adapter_id)
            job["adapter_dir"] = str(folder)
            job["model_id"] = json.loads((folder / "result.json").read_text()).get("model_id") or job["model_id"]
        if not self._busy.acquire(blocking=False):
            raise ApiError(409, "busy", "A training run is using the GPU. Try again when it has finished.")
        got: dict[str, Any] = {}
        try:
            self.runner([str(self.python), str(self.script)], json.dumps(job),
                        lambda e: got.update(e) if e.get("type") in ("result", "error") else None,
                        threading.Event(), TRY_TIMEOUT_S)
        finally:
            self._busy.release()
        if got.get("type") != "result":
            raise ApiError(502, "lora_failed", got.get("message") or "The model did not answer. See the backend log.")
        return {k: got[k] for k in ("base", "adapter", "base_json", "adapter_json")} | {"model_id": job["model_id"]}
