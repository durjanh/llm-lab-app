"""A deliberately flaky CRM: the first POST gets a 503, later ones are stored. GET /received reads back the last one."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

calls = 0
received: dict = {}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_POST(self) -> None:
        global calls, received
        raw = self.rfile.read(int(self.headers.get("content-length", 0)))
        calls += 1
        if calls == 1:
            return self._send(503, {"error": "CRM unavailable (deliberate first-call failure)"})
        received = {"attempt": calls, "body": json.loads(raw or "null")}
        self._send(200, {"ok": True, "attempt": calls})

    def do_GET(self) -> None:
        self._send(200, received)

    def log_message(self, *args) -> None:
        pass


HTTPServer(("0.0.0.0", 3000), Handler).serve_forever()
