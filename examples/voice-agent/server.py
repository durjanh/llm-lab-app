"""A small local text-to-speech server: Kokoro-82M through ONNX Runtime, no cloud and no PyTorch.

The lab's /voice-agent page starts this as a subprocess (backend/app/gateways/local_tts.py) from this folder's own
.venv, and talks to it on 127.0.0.1. One loaded model answers every request, one at a time.

    POST /synthesize  {"text": "...", "voice": "bf_emma", "speed": 1.0}  ->  audio/wav, 24 kHz mono
    GET  /health      ->  {"ok": true, "pid": 1234, "voices": [...]}   (the pid tells the backend this is its own child)

Run it on its own:  .venv/bin/python server.py --models ../../generated/voice-agent/kokoro --port 8098
"""
from __future__ import annotations

import argparse
import io
import json
import os
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

MAX_TEXT = 1200
MAX_BODY = 8 * 1024
VOICES = {"bf_emma": "en-gb", "bf_isabella": "en-gb", "bm_george": "en-gb", "bm_lewis": "en-gb",
          "af_heart": "en-us", "af_bella": "en-us", "am_michael": "en-us"}


def wav_bytes(samples: np.ndarray, rate: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return out.getvalue()


def make_handler(kokoro, lock: threading.Lock):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:  # quiet: the backend logs what matters
            pass

        def _send(self, status: int, body: bytes, kind: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send(200, json.dumps({"ok": True, "pid": os.getpid(), "voices": list(VOICES)}).encode())
            else:
                self._send(404, b'{"error": "not found"}')

        def do_POST(self) -> None:
            if self.path != "/synthesize":
                return self._send(404, b'{"error": "not found"}')
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    raise ValueError("body size")
                body = json.loads(self.rfile.read(length))
                text, voice = str(body["text"]).strip(), str(body.get("voice", "bf_emma"))
                speed = float(body.get("speed", 1.0))
                if not text or len(text) > MAX_TEXT or voice not in VOICES or not 0.5 <= speed <= 2.0:
                    raise ValueError("invalid request")
            except (ValueError, KeyError, TypeError, json.JSONDecodeError):
                return self._send(400, b'{"error": "invalid request"}')
            try:
                with lock:  # ONNX Runtime sessions are fine in threads, but one at a time keeps latency predictable
                    samples, rate = kokoro.create(text, voice=voice, speed=speed, lang=VOICES[voice])
                self._send(200, wav_bytes(samples, rate), "audio/wav")
            except Exception as exc:  # noqa: BLE001
                self._send(500, json.dumps({"error": f"{type(exc).__name__}: {exc}"}).encode())

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True, help="folder with kokoro-v1.0.onnx and voices-v1.0.bin")
    parser.add_argument("--port", type=int, default=8098)
    args = parser.parse_args()
    from kokoro_onnx import Kokoro
    kokoro = Kokoro(str(args.models / "kokoro-v1.0.onnx"), str(args.models / "voices-v1.0.bin"))
    kokoro.create("Ready.", voice="bf_emma", speed=1.0, lang="en-gb")  # warm up, so the first request is not slow
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(kokoro, threading.Lock()))
    print(f"Kokoro ready on 127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
