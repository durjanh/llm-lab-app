"""The local open text to speech voice: Kokoro-82M in its own environment (examples/voice-agent), run as a small
server on this machine. Nothing leaves the machine and PyTorch is not needed.

The backend starts the server the first time the voice is used and stops it on exit. It needs the folder's own .venv
and the model files in generated/voice-agent/kokoro (examples/voice-agent/README.md has the three set-up commands).
"""
from __future__ import annotations

import atexit
import json
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Protocol

START_TIMEOUT_S = 90.0
REQUEST_TIMEOUT_S = 30.0
MODEL_FILES = ("kokoro-v1.0.onnx", "voices-v1.0.bin")
SETUP = "See examples/voice-agent/README.md: a Python 3.12 .venv, then the two model files (about 330 MB)."


class LocalSynth(Protocol):
    def status(self) -> dict[str, Any]: ...
    def synthesize(self, text: str, voice: str, speed: float) -> bytes: ...
    def stop(self) -> None: ...


class LocalTtsError(RuntimeError):
    """The local voice is not set up, did not start, or failed; the message is fit for the page."""


class LocalTts:
    def __init__(self, folder: Path, models: Path, port: int):
        self.folder, self.models, self.port = folder, models, port
        self.python = folder / ".venv" / "bin" / "python"
        self._process: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._ready = False  # health-checked once at start; after that a live process is enough
        atexit.register(self.stop)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def installed(self) -> str | None:
        """None when it can run; otherwise what is missing."""
        if not self.python.exists():
            return f"The local voice has no environment yet. {SETUP}"
        missing = [f for f in MODEL_FILES if not (self.models / f).exists()]
        return f"The local voice is missing its model files ({', '.join(missing)}). {SETUP}" if missing else None

    def status(self) -> dict[str, Any]:
        reason = self.installed()
        return {"installed": reason is None, "reason": reason or "", "running": self._alive(), "engine": "Kokoro-82M (ONNX)"}

    def _alive(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def _answering_pid(self) -> int | None:
        """The pid of whatever voice server answers on the port (0 if it gives none), or None when nothing answers."""
        try:
            with urllib.request.urlopen(f"{self.url}/health", timeout=1.0) as r:
                body = json.loads(r.read())
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            return None
        if not isinstance(body, dict) or not body.get("ok"):
            return None
        pid = body.get("pid")
        return pid if isinstance(pid, int) and not isinstance(pid, bool) else 0

    def _healthy(self) -> bool:
        """Our own child answers. Anything else on the port (another program, a server left from an earlier run) does
        not count, so text is never posted to it and a dead child is never taken for a ready one."""
        return self._process is not None and self._answering_pid() == self._process.pid

    def _ensure(self) -> None:
        # The health probe runs only while starting. Probing before every sentence cost a round trip each time, and
        # timed out while the single-threaded server was busy with another sentence, which then killed it mid-reply.
        with self._lock:
            if self._alive() and self._ready:
                return
            reason = self.installed()
            if reason:
                raise LocalTtsError(reason)
            self.stop()
            if self._answering_pid() is not None:  # the new server could not bind: say so rather than use what is there
                raise LocalTtsError(f"Something else is already answering on port {self.port}. Stop it, or set "
                                    "VOICE_AGENT_LOCAL_TTS_PORT to a free port.")
            self._process = subprocess.Popen(
                [str(self.python), str(self.folder / "server.py"), "--models", str(self.models), "--port", str(self.port)],
                cwd=self.folder, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + START_TIMEOUT_S
            while time.monotonic() < deadline:
                if self._process.poll() is not None:
                    raise LocalTtsError("The local voice stopped while starting. Run examples/voice-agent/server.py by hand to see why.")
                if self._healthy():
                    self._ready = True
                    return
                time.sleep(0.25)
            self.stop()
            raise LocalTtsError("The local voice took too long to start.")

    def synthesize(self, text: str, voice: str, speed: float) -> bytes:
        self._ensure()
        request = urllib.request.Request(f"{self.url}/synthesize", method="POST",
                                         data=json.dumps({"text": text, "voice": voice, "speed": speed}).encode(),
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            raise LocalTtsError(f"The local voice refused the text (HTTP {exc.code}).") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise LocalTtsError(f"Could not reach the local voice: {exc}") from exc

    def stop(self) -> None:
        self._ready = False
        process, self._process = self._process, None
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
