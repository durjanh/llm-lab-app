"""Failover for every page: a model call that is rate limited (429), overloaded (529), failing (5xx) or timing out is
sent to the next model in the failover catalog (config/model-failover.json or Table Storage), the order /model-failover
shows and edits. One router serves the whole lab, so its circuit breakers are shared: a model that keeps failing on one
page is skipped on every page until its cooldown ends, and a probe then tests it again.

It wraps the gateway every service already uses, so no service changes:
- Only a model that is in the catalog fails over. Any other (the local model, unless the catalog lists it) is called
  as it was; otherwise the router would send it to the catalog's first model instead.
- A model that cannot do a request (it needs a Claude-only feature, or reads images the model cannot) is passed over
  without marking it unhealthy; the router's own rule for that is in model_router.classify.
- A stream switches only before it starts, never part-way through a reply; an error part-way through a stream is
  the caller's, and does not count against the model's breaker.
- When every model in the catalog fails, the client's own fallback model (LLM_LAB_RATE_LIMIT_FALLBACK) is tried once
  if the catalog does not list it, as before.
- The lab client's own one-step fallback is switched off inside a routed call (without_fallback), so a request is
  never switched twice. Code that drives the SDK client directly (the coding agent, the harness, skills and decks)
  keeps that one-step fallback.
- LLM_LAB_FAILOVER=off turns it off: every call goes straight to the model asked for.

/model-failover routes its own calls (it shows each step), so it is given the gateway underneath, not this one.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from typing import Any

from ..core.telemetry import current_area
from ..shared import fallback_model, without_fallback
from .model_router import AllPoolsFailed, ModelRouter

KEEP = 50  # switches remembered for the page


class FailoverGateway:
    """The lab's model gateway with failover across the catalog's models. Everything else passes straight through."""

    def __init__(self, inner: Any, router: ModelRouter, enabled: bool = True):
        self.inner, self.router, self.enabled = inner, router, enabled
        self._switches: deque[dict[str, Any]] = deque(maxlen=KEEP)
        self._lock = threading.Lock()
        self.routed = 0

    def __getattr__(self, name: str) -> Any:  # client, files, batches, count_tokens...: the gateway underneath
        if name == "inner":  # not set yet (a copy, a mock): no endless lookup through __getattr__
            raise AttributeError(name)
        return getattr(self.inner, name)

    def _routable(self, model: Any) -> bool:
        return bool(self.enabled and isinstance(model, str) and self.router.get(model) is not None)

    def _note(self, asked: str) -> Any:
        area = current_area()

        def on_event(event: dict[str, Any]) -> None:
            if event.get("type") == "switch":
                with self._lock:
                    self._switches.append({"at": time.time(), "area": area, "asked": asked, "from": event["from"],
                                           "to": event["to"], "reason": event.get("reason", "")})
        return on_event

    def _count(self) -> None:
        with self._lock:
            self.routed += 1

    def _last_resort(self, model: str) -> str | None:
        """The client's own fallback model (LLM_LAB_RATE_LIMIT_FALLBACK), when the catalog does not list it: tried once
        after every catalog model failed, as it was before failover went lab-wide."""
        alt = fallback_model(model)
        return alt if alt and alt != model and self.router.get(alt) is None else None

    def create(self, **params: Any) -> Any:
        model = params.get("model")
        if not self._routable(model):
            return self.inner.create(**params)
        self._count()

        def send(pool: Any) -> Any:
            with without_fallback():  # the router chooses the model: the client must not switch it again
                return self.inner.create(**{**params, "model": pool.model})

        try:
            return self.router.call(send, model, self._note(model)).result
        except AllPoolsFailed:
            if not (alt := self._last_resort(model)):
                raise
            self._note(model)({"type": "switch", "from": model, "to": alt, "reason": "every model in the list failed"})
            with without_fallback():
                return self.inner.create(**{**params, "model": alt})

    @contextmanager
    def stream(self, **params: Any) -> Iterator[Any]:
        model = params.get("model")
        if not self._routable(model):
            with self.inner.stream(**params) as s:
                yield s
            return
        self._count()
        with ExitStack() as stack:
            def send(pool: Any) -> Any:  # opening the stream is the call that can fail over; its text cannot
                with without_fallback():
                    return stack.enter_context(self.inner.stream(**{**params, "model": pool.model}))

            yield self.router.call(send, model, self._note(model)).result

    def report(self) -> dict[str, Any]:
        """For the page: whether it is on, which models it covers, and the latest switches on any page."""
        with self._lock:
            recent = list(reversed(self._switches))
        return {"enabled": self.enabled, "models": [p.model for p in self.router.order()] if self.enabled else [],
                "routed_calls": self.routed, "switches": recent}
