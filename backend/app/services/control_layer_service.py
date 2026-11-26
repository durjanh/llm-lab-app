"""The control layer's page and proxy: the usage, cost and access figures the page shows, and Anthropic-compatible
requests from outside coding agents, run under their virtual key's policy through the lab's own gateway.

A proxied call is named after its key ("key:<id>") for the length of the call, so the control layer applies that
key's policy and the call log and ledger record it under the key. It goes through the same failover gateway as the
pages, and is charged to the lab's spend tracker by the model that answered. The client's key never goes upstream;
the lab's own credentials never come back.
"""
from __future__ import annotations

import contextvars
import json
import queue
import threading
from collections import defaultdict
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from typing import Any

from ..core.errors import ApiError
from ..core.telemetry import use_area
from ..settings import CLAUDE_MODELS, MODELS
from .assistant_agent import efforts_for
from .control_layer import EFFORTS, ControlLayer
from .spend import SpendTracker

ROUTE = "POST /control/v1/messages"
WIRE_EVENTS = {"message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta",
               "message_stop", "ping", "error"}  # the stream helper's own events (text, thinking...) are not sent
# What a key holder may send. Left out on purpose: mcp_servers, container, service_tier and context_management, and
# server tools (web search, web fetch, code execution...): they would run under the lab's credentials, can reach any
# address on the internet, and are billed in ways the spend tracker does not price.
ALLOWED_FIELDS = {"model", "messages", "max_tokens", "system", "tools", "tool_choice", "temperature", "top_p", "top_k",
                  "stop_sequences", "metadata", "thinking", "output_config", "stream"}
CLIENT_TOOL_FIELDS = {"name", "description", "input_schema", "cache_control", "type", "strict"}
MAX_TOKENS = 64_000
DAYS_SHOWN = 30


def anthropic_error(status: int, message: str) -> dict[str, Any]:
    """An error in the shape the Messages API uses, so a client shows it as it would the real one."""
    kind = {400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error",
            413: "request_too_large", 429: "rate_limit_error", 529: "overloaded_error"}.get(status, "api_error")
    return {"type": "error", "error": {"type": kind, "message": message}}


def dump(obj: Any) -> dict[str, Any]:
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json")
    return json.loads(json.dumps(obj, default=lambda o: getattr(o, "__dict__", str(o))))


def sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()


def upstream_status(exc: BaseException) -> tuple[int, str]:
    """The status and message to give the client for a failed call, never the upstream request or its headers."""
    if isinstance(exc, ApiError):
        return exc.status, exc.message
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        body = getattr(exc, "body", None)
        message = body.get("error", {}).get("message") if isinstance(body, dict) else None
        return status, str(message or f"The model returned {status}.")
    return 502, f"The call could not be completed ({type(exc).__name__})."


class ControlLayerService:
    def __init__(self, control: ControlLayer, gateway: Any, spend: SpendTracker):
        self.control, self.gateway, self.spend = control, gateway, spend

    # ---------- the page ----------
    def models(self) -> list[dict[str, Any]]:
        return [{"id": m, "efforts": efforts_for(m)} for m in MODELS]

    def overview(self) -> dict[str, Any]:
        ledger, savings, calls = self.control.ledger()
        policies, keys = self.control.policies(), self.control.keys()
        names = {f"key:{k['id']}": k["name"] for k in keys}
        log = self.spend.call_log.calls()
        areas = {c.get("area", "background") for c in log}
        consumers = sorted(set(ledger) | set(policies) | set(names) | areas)
        now = self.control.clock()
        today = datetime.fromtimestamp(now, tz=timezone.utc).date()
        days = [(today - timedelta(days=i)).isoformat() for i in range(DAYS_SHOWN - 1, -1, -1)]
        month = today.strftime("%Y-%m")

        rows = []
        for c in consumers:
            spent_today, spent_month = self.control.spent(c, now)
            p = policies.get(c)
            rows.append({
                "id": c, "label": names.get(c, c), "kind": "key" if c.startswith("key:") else "area",
                "today_usd": round(spent_today, 6), "month_usd": round(spent_month, 6),
                "projected_month_usd": round(self.control.projection(c), 6),
                "calls_today": calls.get(c, {}).get(today.isoformat(), 0),
                "saved_month_usd": round(sum(v for d, v in savings.get(c, {}).items() if d.startswith(month)), 6),
                "policy": p,
            })
        rows.sort(key=lambda r: (-r["month_usd"], r["id"]))

        by_day = [{"day": d, "total_usd": round(sum(ledger.get(c, {}).get(d, 0.0) for c in ledger), 6),
                   "by_consumer": {c: round(v[d], 6) for c, v in ledger.items() if v.get(d)}} for d in days]
        models: dict[str, dict[str, Any]] = defaultdict(lambda: {"calls": 0, "cost_usd": 0.0, "errors": 0})
        for c in log:
            m = models[str(c.get("model") or "unknown")]
            m["calls"] += 1
            m["cost_usd"] += float(c.get("cost_usd") or 0)
            m["errors"] += c.get("status") == "error"
        return {
            "consumers": rows,
            "by_day": by_day,
            "by_model": sorted(({"model": k, **{**v, "cost_usd": round(v["cost_usd"], 6)}} for k, v in models.items()),
                               key=lambda r: -r["cost_usd"]),
            "totals": {"today_usd": round(sum(r["today_usd"] for r in rows), 6),
                       "month_usd": round(sum(r["month_usd"] for r in rows), 6),
                       "saved_month_usd": round(sum(r["saved_month_usd"] for r in rows), 6),
                       "blocked": len(self.control.blocked(200)), "policies": len(policies),
                       "active_keys": sum(1 for k in keys if not k.get("revoked_at")),
                       "session_spent_usd": round(self.spend.spent_usd, 6),
                       "session_budget_usd": self.spend.budget_usd},
            "blocked": self.control.blocked(50),
            "keys": keys,
            "audit": self.control.audit(50),
            "models": self.models(),
            "efforts": EFFORTS,
            "call_log_size": len(log),
        }

    # ---------- the proxy ----------
    def check_request(self, body: Any) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise ApiError(400, "invalid_request", "The body must be a JSON object.")
        unknown = set(body) - ALLOWED_FIELDS
        if unknown:
            raise ApiError(400, "invalid_request", f"Not supported through the lab's proxy: {', '.join(sorted(unknown))}. "
                                                   "These would run under the lab's credentials.")
        if "stream" in body and not isinstance(body["stream"], bool):
            raise ApiError(400, "invalid_request", "stream must be true or false.")
        tools = body.get("tools")
        if tools is not None:
            if not isinstance(tools, list):
                raise ApiError(400, "invalid_request", "tools must be a list.")
            for tool in tools:
                self._check_tool(tool)
        if body.get("model") not in MODELS:
            raise ApiError(400, "invalid_request", f"model must be one of the lab's models: {', '.join(MODELS)}.")
        if not isinstance(body.get("messages"), list) or not body["messages"]:
            raise ApiError(400, "invalid_request", "messages must be a list with at least one message.")
        max_tokens = body.get("max_tokens")
        if not isinstance(max_tokens, int) or not 1 <= max_tokens <= MAX_TOKENS:
            raise ApiError(400, "invalid_request", f"max_tokens must be a whole number from 1 to {MAX_TOKENS:,}.")
        if self.spend.over_budget:
            raise ApiError(429, "budget_exceeded", "The lab's spending cap for this session has been reached.")
        return {k: v for k, v in body.items() if k != "stream"}

    @staticmethod
    def _check_tool(tool: Any) -> None:
        """Only the caller's own tools, which the caller runs: a name, a description and an input schema. Server tools
        (anything with a type other than "custom") would run on the provider under the lab's credentials."""
        if not isinstance(tool, dict):
            raise ApiError(400, "invalid_request", "Each tool must be an object.")
        kind = tool.get("type", "custom")
        if kind != "custom":
            raise ApiError(400, "invalid_request", f"Server tools are not available through the lab's proxy ({kind}): "
                                                   "they would run under the lab's credentials. Use your own tools.")
        extra = set(tool) - CLIENT_TOOL_FIELDS
        if extra:
            raise ApiError(400, "invalid_request", f"Not supported in a tool: {', '.join(sorted(extra))}.")
        if not isinstance(tool.get("name"), str) or not isinstance(tool.get("input_schema"), dict):
            raise ApiError(400, "invalid_request", "Each tool needs a name and an input_schema object.")

    @staticmethod
    def _extra(params: dict[str, Any], beta: str | None) -> dict[str, Any]:
        """Beta features the client asked for, passed on for Claude models only (other models' clients reject them)."""
        if beta and params["model"] in CLAUDE_MODELS:
            return {**params, "extra_headers": {"anthropic-beta": beta[:500]}}
        return params

    def create(self, consumer: str, body: dict[str, Any], beta: str | None) -> dict[str, Any]:
        params = self.check_request(body)
        with use_area(consumer, ROUTE):
            message = self.gateway.create(**self._extra(params, beta))
            self.spend.charge(message, params["model"])
        return dump(message)

    def count_tokens(self, body: Any) -> dict[str, Any]:
        if not isinstance(body, dict) or body.get("model") not in CLAUDE_MODELS:
            raise ApiError(400, "invalid_request", f"Token counting needs one of: {', '.join(CLAUDE_MODELS)}.")
        params = {k: v for k, v in body.items() if k in {"model", "messages", "system", "tools", "tool_choice",
                                                          "thinking"}}
        return {"input_tokens": self.gateway.count_tokens(**params)}

    def open_stream(self, consumer: str, body: dict[str, Any], beta: str | None) -> Iterator[bytes]:
        """Opens a streamed call and returns its server-sent events. Opening is waited for, so a refusal by a policy,
        the budget or the model arrives as a normal HTTP error rather than inside a stream that has already begun."""
        params = self.check_request(body)
        out: queue.Queue[Any] = queue.Queue()
        stop = threading.Event()
        context = contextvars.copy_context()

        def work() -> None:
            opened: list[Any] = []  # the stream, once open
            charged = False

            def charge(message: Any) -> None:
                """Charges a reply once: a whole one, or what was produced before the client left or the call failed."""
                nonlocal charged
                if not charged and message is not None and getattr(message, "usage", None) is not None:
                    charged = True
                    self.spend.charge(message, params["model"])

            try:
                with use_area(consumer, ROUTE):  # charged inside the key's area, so the call log names the key
                    try:
                        with self.gateway.stream(**self._extra(params, beta)) as s:
                            opened.append(s)
                            out.put(("opened", None))
                            for event in s:
                                if stop.is_set():
                                    break
                                kind = getattr(event, "type", None) or (event.get("type") if isinstance(event, dict)
                                                                        else None)
                                if kind in WIRE_EVENTS:
                                    out.put(sse(kind, dump(event)))
                            charge(getattr(s, "current_message_snapshot", None) if stop.is_set()
                                   else s.get_final_message())
                    finally:  # failed part-way: what was produced was still billed
                        if opened and not charged:
                            try:
                                charge(getattr(opened[0], "current_message_snapshot", None))
                            except Exception:  # noqa: BLE001 - a broken snapshot must not hide the real error
                                pass
            except BaseException as exc:  # noqa: BLE001 - every failure reaches the client, opened or not
                out.put(("failed", exc))
            finally:
                out.put(None)

        threading.Thread(target=context.run, args=(work,), daemon=True, name=f"control-stream-{consumer}").start()
        first = out.get()
        if first is None:
            raise ApiError(502, "upstream", "The stream closed before it opened.")
        if first[0] == "failed":
            status, message = upstream_status(first[1])
            raise ApiError(status, "upstream", message)

        def lines() -> Iterator[bytes]:
            try:
                while True:
                    item = out.get()
                    if item is None:
                        return
                    if isinstance(item, tuple):  # failed part-way: an error event, as the Messages API sends one
                        status, message = upstream_status(item[1])
                        yield sse("error", anthropic_error(status, message))
                        continue
                    yield item
            finally:
                stop.set()  # the client went away: the worker stops reading and the reply is not charged twice

        return lines()

