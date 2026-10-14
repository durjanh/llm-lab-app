"""Local server for the LLM Lab.

Serves the lab pages over http://localhost, which avoids browser limits on pages
opened from disk, and proxies Claude API calls for the live features. Your API
key stays in this process and never reaches the browser.

    python python/server.py                  # then open http://localhost:8000
    python python/server.py --port 8080 --budget 5

Safety: it listens on 127.0.0.1 only, refuses API calls from other websites,
caps max_tokens, and stops making calls once the estimated spend for this
session reaches --budget dollars (default 2).
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import anthropic

from common import DEFAULT_MODEL, PRICES, cost_usd, create, make_client, stream
from data import HANDBOOK

ROOT = Path(__file__).resolve().parent.parent
MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
ALLOWED_PARAMS = {"model", "max_tokens", "system", "messages", "tools", "tool_choice",
                  "output_config", "cache_control", "stop_sequences"}
MAX_TOKENS_CAP = 32000          # streaming requests
MAX_TOKENS_NON_STREAMING = 16000  # the SDK requires streaming for larger values


class Session:
    def __init__(self, budget: float, port: int):
        self.client = make_client()
        self.budget = budget
        self.port = port
        self.spent = 0.0
        self.calls = 0
        self.lock = threading.Lock()
        self.has_credentials: bool | None = None

    def credentials_ok(self) -> bool:
        if self.has_credentials is None:
            try:
                self.client.models.retrieve(DEFAULT_MODEL)  # metadata only, generates nothing
                self.has_credentials = True
            except anthropic.AuthenticationError:
                self.has_credentials = False
            except TypeError as exc:  # raised when no credentials can be found at all
                self.has_credentials = "authentication" not in str(exc).lower()
            except anthropic.APIError:
                self.has_credentials = True  # credentials exist; other problems surface on real calls
        return self.has_credentials

    def charge(self, message, model: str) -> float | None:
        cost = cost_usd(message.usage, model)
        with self.lock:
            self.calls += 1
            self.spent += cost or 0
        return cost


class Handler(SimpleHTTPRequestHandler):
    session: Session

    # ---------- helpers ----------
    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def error_json(self, status: int, kind: str, message: str) -> None:
        self.send_json(status, {"error": {"type": kind, "message": message}})

    def same_origin(self) -> bool:
        port = self.session.port
        hosts = {f"localhost:{port}", f"127.0.0.1:{port}"}
        if self.headers.get("Host") not in hosts:  # blocks DNS-rebinding tricks
            return False
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc not in hosts:
            return False
        # A custom header forces a CORS preflight, which this server never approves,
        # so other websites cannot make your browser call this API.
        return self.headers.get("X-LLM-Lab") == "1"

    def read_params(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        params = {k: v for k, v in body.items() if k in ALLOWED_PARAMS}
        params["model"] = params.get("model") or DEFAULT_MODEL
        if params["model"] not in MODELS:
            raise ValueError(f"Model must be one of: {', '.join(MODELS)}")
        params["max_tokens"] = max(1, min(int(params.get("max_tokens") or 4096), MAX_TOKENS_CAP))
        if not isinstance(params.get("messages"), list) or not params["messages"]:
            raise ValueError("messages must be a non-empty list")
        return params

    def over_budget(self) -> bool:
        if self.session.spent >= self.session.budget:
            money = (lambda v: f"${v:.4f}" if v < 0.1 else f"${v:.2f}")
            self.error_json(429, "budget_exceeded",
                            f"This session has spent about {money(self.session.spent)}, which reached the "
                            f"{money(self.session.budget)} budget. Restart the server with a higher --budget to continue.")
            return True
        return False

    def api_error(self, exc: Exception) -> None:
        if isinstance(exc, anthropic.APIStatusError):
            self.error_json(exc.status_code, "api_error", exc.message)
        elif isinstance(exc, anthropic.APIConnectionError):
            self.error_json(502, "connection_error", "Could not reach the Claude API.")
        elif isinstance(exc, TypeError) and "authentication" in str(exc).lower():
            self.error_json(401, "no_credentials", "No API credentials. Set ANTHROPIC_API_KEY and restart the server.")
        elif isinstance(exc, (ValueError, json.JSONDecodeError)):
            self.error_json(400, "invalid_request", str(exc))
        else:
            raise exc

    def status_payload(self) -> dict:
        s = self.session
        return {"ok": True, "has_credentials": s.credentials_ok(), "default_model": DEFAULT_MODEL, "models": MODELS,
                "prices": PRICES, "spent_usd": round(s.spent, 4), "budget_usd": s.budget, "calls": s.calls}

    # ---------- routes ----------
    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/status":
            return self.send_json(200, self.status_payload())
        if path == "/api/sample/handbook":
            return self.send_json(200, {"text": HANDBOOK})
        if any(part.startswith(".") for part in path.split("/")):
            return self.error_json(404, "not_found", "Not found")
        return super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self.error_json(404, "not_found", "Not found")
        if not self.same_origin():
            return self.error_json(403, "forbidden", "API calls are only accepted from the lab pages on this server.")
        try:
            params = self.read_params()
        except Exception as exc:
            return self.api_error(exc)

        if path == "/api/count_tokens":
            try:
                keep = {k: params[k] for k in ("model", "messages", "system", "tools") if k in params}
                result = self.session.client.messages.count_tokens(**keep)
                return self.send_json(200, {"input_tokens": result.input_tokens})
            except Exception as exc:
                return self.api_error(exc)

        if self.over_budget():
            return
        if path == "/api/messages":
            params["max_tokens"] = min(params["max_tokens"], MAX_TOKENS_NON_STREAMING)
            start = time.perf_counter()
            try:
                message = create(self.session.client, **params)
            except Exception as exc:
                return self.api_error(exc)
            cost = self.session.charge(message, params["model"])
            self.log_call(params["model"], message, cost)
            return self.send_json(200, {
                "message": message.model_dump(mode="json", by_alias=True, exclude_none=True),
                "timing": {"total_ms": round((time.perf_counter() - start) * 1000)},
                "cost_usd": cost, "spent_usd": round(self.session.spent, 4)})
        if path == "/api/stream":
            return self.stream_response(params)
        return self.error_json(404, "not_found", "Not found")

    def stream_response(self, params: dict) -> None:
        # Newline-delimited JSON: {"type":"text"} lines, then one {"type":"done"} or {"type":"error"} line.
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.close_connection = True

        def line(obj: dict) -> None:
            self.wfile.write((json.dumps(obj) + "\n").encode())
            self.wfile.flush()

        start = time.perf_counter()
        first = None
        try:
            with stream(self.session.client, **params) as s:
                for text in s.text_stream:
                    if first is None:
                        first = time.perf_counter()
                    line({"type": "text", "text": text})
                message = s.get_final_message()
        except anthropic.APIStatusError as exc:
            return line({"type": "error", "message": f"API error {exc.status_code}: {exc.message}"})
        except anthropic.APIConnectionError:
            return line({"type": "error", "message": "Could not reach the Claude API."})
        except TypeError as exc:
            return line({"type": "error", "message": "No API credentials." if "authentication" in str(exc).lower() else str(exc)})
        end = time.perf_counter()
        cost = self.session.charge(message, params["model"])
        self.log_call(params["model"], message, cost)
        line({"type": "done", "message": message.model_dump(mode="json", by_alias=True, exclude_none=True),
              "timing": {"ttft_ms": round(((first or end) - start) * 1000), "total_ms": round((end - start) * 1000)},
              "cost_usd": cost, "spent_usd": round(self.session.spent, 4)})

    # ---------- logging ----------
    def log_call(self, model: str, message, cost: float | None) -> None:
        u = message.usage
        print(f"  {model}: in {u.input_tokens:,} out {u.output_tokens:,} "
              f"cache read {getattr(u, 'cache_read_input_tokens', 0) or 0:,} "
              f"${(cost or 0):.4f} · session total ${self.session.spent:.4f}", flush=True)

    def log_message(self, fmt: str, *args) -> None:
        if self.command == "POST" or (args and str(args[1]).startswith(("4", "5"))):
            sys.stderr.write(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--budget", type=float, default=2.0, help="stop making API calls after this many dollars")
    args = parser.parse_args()

    Handler.session = Session(args.budget, args.port)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(ROOT)))
    ok = Handler.session.credentials_ok()
    print(f"LLM Lab running at http://localhost:{args.port}")
    print(f"Claude API credentials: {'found' if ok else 'not found. Live features are off. Set ANTHROPIC_API_KEY and restart.'}")
    print(f"Spending cap for this session: ${args.budget:.2f}. Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"\nStopped. Estimated spend this session: ${Handler.session.spent:.4f}")


if __name__ == "__main__":
    main()
