"""The shop's order-status API: the back end the support agent calls through its OpenAPI tool.

Standard library only, so it runs on a plain python image with no build: setup.sh deploys it to Azure Container
Apps, because Foundry calls the tool from the cloud and cannot reach your machine. The orders are invented; dates
are relative to today, so the delays stay delays.

    python examples/support-agent/order_api.py          # http://127.0.0.1:8090/orders/SO-10533, /openapi.json
"""
from __future__ import annotations

import json
import os
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def orders() -> dict[str, dict]:
    today = date.today()
    d = lambda days: (today + timedelta(days=days)).isoformat()  # noqa: E731
    return {
        "SO-10482": {"status": "shipped", "item": "Tessaline router", "carrier": "Parcelwise", "tracking": "PW7719304",
                     "dispatched": d(-1), "estimated_delivery": d(2)},
        "SO-10517": {"status": "processing", "item": "Quorvex filter cartridge (pack of 3)",
                     "estimated_dispatch": d(1), "estimated_delivery": d(4)},
        "SO-10533": {"status": "delayed", "item": "Brindlewave hub", "carrier": "Parcelwise", "tracking": "PW7702218",
                     "dispatched": d(-6), "original_estimated_delivery": d(-2), "estimated_delivery": d(3),
                     "delay_reason": "Held at the carrier's depot after a sorting fault"},
        "SO-10560": {"status": "delivered", "item": "Vellacor sensor", "carrier": "Parcelwise", "tracking": "PW7688102",
                     "delivered": d(-3)},
    }


SPEC = {
    "openapi": "3.0.3",
    "info": {"title": "Order status", "version": "1.0",
             "description": "Look up a customer's order by its order number."},
    "paths": {"/orders/{orderId}": {"get": {
        "operationId": "getOrderStatus",
        "summary": "Status, delivery estimate and tracking for one order",
        "description": "Use when the customer asks where an order is or when it will arrive. Order numbers look like SO-10482.",
        "parameters": [{"name": "orderId", "in": "path", "required": True, "schema": {"type": "string"},
                        "description": "The order number, for example SO-10482"}],
        "responses": {
            "200": {"description": "The order", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Order"}}}},
            "404": {"description": "No order with that number"}}}}},
    "components": {"schemas": {"Order": {"type": "object", "properties": {
        "order_id": {"type": "string"}, "status": {"type": "string", "enum": ["processing", "shipped", "delayed", "delivered"]},
        "item": {"type": "string"}, "carrier": {"type": "string"}, "tracking": {"type": "string"},
        "dispatched": {"type": "string", "format": "date"}, "estimated_delivery": {"type": "string", "format": "date"},
        "original_estimated_delivery": {"type": "string", "format": "date"}, "delay_reason": {"type": "string"},
        "delivered": {"type": "string", "format": "date"}}}}},
}


class Handler(BaseHTTPRequestHandler):
    def send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0].rstrip("/")
        if path == "/openapi.json":
            host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host", "")
            scheme = "http" if host.startswith(("127.", "localhost")) else "https"
            return self.send(200, {**SPEC, "servers": [{"url": f"{scheme}://{host}"}]})
        if path.startswith("/orders/"):
            order_id = path.rsplit("/", 1)[-1].upper()
            order = orders().get(order_id)
            return self.send(200, {"order_id": order_id, **order}) if order else \
                self.send(404, {"error": f"No order {order_id}. Order numbers look like SO-10482."})
        if path in ("", "/health"):
            return self.send(200, {"ok": True})
        self.send(404, {"error": "Not found"})

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} {fmt % args}", flush=True)  # the container's log shows each tool call


if __name__ == "__main__":
    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8090"))
    print(f"Order status API on http://{host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
