"""A record of every model call the backend makes: when, which model answered, tokens, cost, how long it took, which
part of the lab asked, and whether it failed or fell back. Counts and timings only: no prompt or reply text is kept.

Three pieces work together. RequestContext (ASGI middleware) gives each request an area ("diet"), a route and a trace
id, held in context variables so the work a request starts carries them. TimedClient wraps the SDK client and times
each create() and stream(), and records the ones that fail. SpendTracker.charge, which every reply already passes
through, writes the finished call to the CallLog with the latency the client measured.
"""
from __future__ import annotations

import contextvars
import json
import re
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any

MAX_CALLS = 2000  # kept in memory and in the file; older calls are dropped
MATCH_WINDOW_S = 30.0  # a stream's latency is paired with a charge made this soon after, on the same thread

_area: contextvars.ContextVar[str] = contextvars.ContextVar("llm_lab_area", default="background")
_route: contextvars.ContextVar[str] = contextvars.ContextVar("llm_lab_route", default="")
_trace: contextvars.ContextVar[str] = contextvars.ContextVar("llm_lab_trace", default="")
_pending = threading.local()  # the last call this thread finished, waiting for its charge

# A path segment that is an id (a chat, a run, a file), replaced so the log holds route shapes, not ids or names.
_ID = re.compile(r"^(?:[0-9a-f]{12,}|[0-9a-f-]{32,}|.*\d.*\d.*\d.*|.{25,})$", re.I)


def route_shape(path: str) -> tuple[str, str]:
    """(area, route) for a request path: /api/diet/chats/3f9a…/stream -> ("diet", "/diet/chats/{id}/stream")."""
    parts = [p for p in path.split("/") if p]
    if not parts or parts[0] != "api" or len(parts) < 2:
        return "background", ""
    shaped = [("{id}" if _ID.match(p) else p) for p in parts[1:]]
    if len(shaped) >= 3 and shaped[1] in ("memory", "history"):  # /diet/memory/<name>: the name is a person's
        shaped[2] = "{id}"
    return shaped[0], "/" + "/".join(shaped)


def current() -> dict[str, str]:
    """Where the running code was asked from: the lab area, the route and the request's trace id."""
    return {"area": _area.get(), "route": _route.get(), "trace": _trace.get()}


class RequestContext:
    """ASGI middleware: names the area, route and trace of each /api request for everything it goes on to do."""

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        area, route = route_shape(scope.get("path", ""))
        tokens = (_area.set(area), _route.set(f"{scope.get('method', '')} {route}".strip()),
                  _trace.set(uuid.uuid4().hex[:12]))
        try:
            await self.app(scope, receive, send)
        finally:
            for var, token in zip((_area, _route, _trace), tokens):
                var.reset(token)


class CallLog:
    """The calls, newest last: a bounded list in memory, mirrored to a JSONL file so a restart keeps them."""

    def __init__(self, path: Path | None = None, limit: int = MAX_CALLS):
        self.path, self.limit = path, limit
        self.run = uuid.uuid4().hex[:8]  # this start of the server, to tell its calls from earlier ones
        self.started_at = time.time()
        self._calls: deque[dict[str, Any]] = deque(maxlen=limit)
        self._lock = threading.Lock()
        self._appended = 0
        if path and path.exists():
            try:
                for line in path.read_text().splitlines()[-limit:]:
                    if line.strip():
                        self._calls.append(json.loads(line))
            except (OSError, json.JSONDecodeError):
                self._calls.clear()  # an unreadable log is started again, not half-trusted

    def add(self, **fields: Any) -> dict[str, Any]:
        """Records one call. The area, route and trace come from the request that is running."""
        entry = {"id": uuid.uuid4().hex[:12], "run": self.run, "at": round(time.time(), 3), **current(), **fields}
        with self._lock:
            self._calls.append(entry)
            self._write(entry)
        return entry

    def _write(self, entry: dict[str, Any]) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._appended += 1
            if self._appended > self.limit:  # the file has grown to twice the limit: keep only what memory holds
                self.path.write_text("".join(json.dumps(c) + "\n" for c in self._calls))
                self._appended = 0
            else:
                with self.path.open("a") as f:
                    f.write(json.dumps(entry) + "\n")
        except OSError:
            pass  # monitoring must never break the call it is watching

    def calls(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._calls)

    def clear(self) -> None:
        with self._lock:
            self._calls.clear()
            self._appended = 0
            if self.path:
                try:
                    self.path.unlink(missing_ok=True)
                except OSError:
                    pass

    # ----- what the timed client and the spend tracker report -----

    def finished(self, kind: str, started: float, seconds: float, response: Any = None) -> None:
        """A call that returned. Its latency waits on this thread for the charge that follows."""
        _pending.call = {"kind": kind, "started": started, "latency_ms": round(seconds * 1000),
                         "response": getattr(response, "id", None) if response is not None else None,
                         "done": time.monotonic()}

    def failed(self, kind: str, model: str, started: float, seconds: float, exc: BaseException) -> None:
        """A call that raised: recorded here, because a failed call is never charged."""
        _pending.call = None
        self.add(kind=kind, status="error", error=type(exc).__name__, model=model, asked=model, fallback=False,
                 started=round(started, 3), latency_ms=round(seconds * 1000), input_tokens=0, output_tokens=0,
                 cache_read_tokens=0, cost_usd=0.0)

    def charged(self, message: Any, asked: str, answered: str, cost: float | None) -> None:
        """A reply that was charged: the tokens and cost, with the latency measured for it if there is one."""
        timing = _take_pending(message)
        u = message.usage
        self.add(kind=timing["kind"] if timing else "untimed", status="ok", error=None, model=answered, asked=asked,
                 fallback=answered != asked, started=round(timing["started"], 3) if timing else None,
                 latency_ms=timing["latency_ms"] if timing else None,
                 input_tokens=_count(u, "input_tokens"), output_tokens=_count(u, "output_tokens"),
                 cache_read_tokens=_count(u, "cache_read_input_tokens"), cost_usd=round(cost or 0.0, 6),
                 priced=cost is not None)

    def charged_usd(self, what: str, cost: float) -> None:
        """A charge in dollars from a service billed by something other than tokens."""
        self.add(kind="service", status="ok", error=None, model=what, asked=what, fallback=False, started=None,
                 latency_ms=None, input_tokens=0, output_tokens=0, cache_read_tokens=0, cost_usd=round(cost, 6),
                 priced=True)


def _count(usage: Any, name: str) -> int:
    value = getattr(usage, name, 0)
    return value if isinstance(value, int) else 0


def _take_pending(message: Any) -> dict[str, Any] | None:
    """The timing this thread measured for this reply, or None. A create() is matched by the reply's id; a stream,
    whose reply is not known when it closes, by being recent."""
    timing = getattr(_pending, "call", None)
    _pending.call = None
    if not timing or time.monotonic() - timing["done"] > MATCH_WINDOW_S:
        return None
    reply = getattr(message, "id", None)
    if timing["response"] is not None and reply is not None and timing["response"] != reply:
        return None
    return timing


class _TimedStream:
    """A stream's context manager, timed from the request to the end of the reply."""

    def __init__(self, manager: Any, log: CallLog, model: str):
        self._manager, self._log, self._model = manager, log, model
        self._started = self._clock = 0.0

    def __enter__(self) -> Any:
        self._started, self._clock = time.time(), time.perf_counter()
        try:
            return self._manager.__enter__()
        except BaseException as exc:
            self._record(exc)
            raise

    def __exit__(self, kind: Any, exc: Any, trace: Any) -> Any:
        try:
            return self._manager.__exit__(kind, exc, trace)
        finally:
            self._record(exc)

    def _record(self, exc: BaseException | None) -> None:
        try:
            seconds = time.perf_counter() - self._clock
            if exc is None or isinstance(exc, GeneratorExit):
                self._log.finished("stream", self._started, seconds)
            else:
                self._log.failed("stream", self._model, self._started, seconds, exc)
        except Exception:
            pass

    def __getattr__(self, name: str) -> Any:
        return getattr(self._manager, name)


class _TimedMessages:
    """client.messages (or client.beta.messages) with create() and stream() timed; everything else passes through."""

    def __init__(self, messages: Any, log: CallLog):
        self._messages, self._log = messages, log

    def create(self, **params: Any) -> Any:
        started, clock = time.time(), time.perf_counter()
        try:
            response = self._messages.create(**params)
        except BaseException as exc:
            try:
                self._log.failed("create", str(params.get("model", "")), started, time.perf_counter() - clock, exc)
            except Exception:
                pass
            raise
        try:
            self._log.finished("create", started, time.perf_counter() - clock, response)
        except Exception:
            pass
        return response

    def stream(self, **params: Any) -> Any:
        return _TimedStream(self._messages.stream(**params), self._log, str(params.get("model", "")))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._messages, name)


class _TimedBeta:
    def __init__(self, beta: Any, log: CallLog):
        self._beta, self._log = beta, log

    @property
    def messages(self) -> _TimedMessages:
        return _TimedMessages(self._beta.messages, self._log)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._beta, name)


class TimedClient:
    """The SDK client (or a stand-in for it), with every messages.create and messages.stream timed and failures
    recorded. Anything else it is asked for comes from the real client unchanged."""

    def __init__(self, client: Any, log: CallLog):
        self._client, self._log = client, log

    @property
    def messages(self) -> _TimedMessages:
        return _TimedMessages(self._client.messages, self._log)

    @property
    def beta(self) -> _TimedBeta:
        return _TimedBeta(self._client.beta, self._log)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)
