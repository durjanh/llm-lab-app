"""Which model answers, and what to do when one is rate limited or overloaded.

The router holds an ordered list of pools. A pool is one deployment of one model (a Claude model on Anthropic, a GPT
deployment in Azure OpenAI). A call starts at the first pool whose circuit breaker lets it through and moves down the list
when a pool fails in a way another pool might not.

What each failure means (classify):
  429 with a short retry-after (2 s or less)     retry once on the same pool, then switch if it fails again
  429 with a long or no retry-after, 529, 5xx,
  a timeout, a dropped connection                 open that pool's breaker and switch to the next pool
  400, 401, 403, 404, 413, 422, a prompt that is
  too long, a request only Claude can run         never switch: the next pool would fail the same way, so raise it

Circuit breaker, per pool: closed (calls go through); open for a cool-down after a failure that asks for a switch (calls
skip the pool, so a struggling service is not hit again and again); half-open once the cool-down ends, when exactly one
call is let through as a probe. A good probe closes the breaker, a bad one opens it again. The cool-down is the longer of
the server's retry-after and the router's own, so a "retry after 30 s" is respected.

Fault injection is for the lab: "the next N calls to this pool fail with 429, 529 or a timeout". An injected fault is
raised before the request is sent, so it costs nothing, and it goes through the same classification as a real one.

All state is behind one lock, so two requests at once cannot corrupt a breaker or use one injected fault twice. The lock
is never held during a model call. The Anthropic SDK retries a 429 or 5xx by itself (two times, by default) before it
raises; a service that owns failover sets max_retries to 0 so the router decides how long to wait. The lab leaves the
SDK as it is, so a real 429 reaches the router after those retries, and says so on the page.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import anthropic
import httpx

from ..core.errors import ApiError
from ..shared import ModelUnavailable, NeedsClaude, is_local  # noqa: F401

SHORT_RETRY_S = 2.0  # a 429 that says "try again in 2 s or less" is retried on the same pool
COOLDOWN_S = 30.0  # how long a pool's breaker stays open at least
MAX_COOLDOWN_S = 300.0
FAULTS = {  # kind -> (status, retry_after_s, what it looks like)
    "429": (429, 30.0, "rate limited, retry-after 30 s"),
    "429_short": (429, 1.0, "rate limited, retry-after 1 s"),
    "529": (529, None, "overloaded"),
    "500": (500, None, "server error"),
    "timeout": (None, None, "timed out"),
}


class ModelFault(Exception):
    """A failure the lab made up (fault injection). It looks like the real thing to classify()."""

    def __init__(self, kind: str):
        status, retry_after, what = FAULTS[kind]
        super().__init__(f"injected: {what}")
        self.kind, self.status_code, self.retry_after, self.injected = kind, status, retry_after, True


class PoolWentDown(Exception):
    """Raised by a send whose own earlier call on this pool (compacting the history before the request) failed and
    opened the pool's breaker. That failure is already counted, so the router moves on without counting it again, and
    without sending the request to a pool it has just marked unhealthy."""


class AllPoolsFailed(ApiError):
    """Every pool was open or failed. The message lists what each said."""

    def __init__(self, tried: list[str]):
        super().__init__(503, "all_models_unavailable",
                         "No model could answer: " + ("; ".join(tried) if tried else "every breaker is open")
                         + ". The conversation is saved up to its last step, so try again when a breaker has reset.")


@dataclass(frozen=True)
class Pool:
    name: str  # the id shown on the page; here the model id
    model: str
    provider: str  # anthropic | azure-openai
    context_tokens: int = 200_000
    note: str = ""  # "same family, cheaper", "other provider"...
    price: dict[str, float] | None = field(default=None, compare=False, hash=False)  # own price when PRICES lacks the model


@dataclass(frozen=True)
class Verdict:
    action: str  # retry | switch | skip | fail
    reason: str
    status: int | None = None
    retry_after: float | None = None


def retry_after_of(exc: Any) -> float | None:
    """The retry-after header (seconds) of an SDK error, or the injected fault's own, or None."""
    if getattr(exc, "injected", False):
        return exc.retry_after
    headers = getattr(getattr(exc, "response", None), "headers", None)
    try:
        value = headers.get("retry-after") if headers is not None else None
        return max(0.0, float(value)) if value is not None else None
    except (TypeError, ValueError):
        return None  # an HTTP date: treated as unknown, which is a long wait


def classify(exc: BaseException, short_retry_s: float = SHORT_RETRY_S) -> Verdict:
    """What a failed call means. See the module note for the table. A 429 asking for short_retry_s or less is retried."""
    if getattr(exc, "injected", False):
        status = exc.status_code
    elif isinstance(exc, anthropic.APIStatusError):
        status = exc.status_code
    else:
        status = None
    if isinstance(exc, PoolWentDown):
        return Verdict("skip", "breaker opened by this call's own summary")
    if isinstance(exc, ApiError) and getattr(exc, "kind", "") == "context_too_long":
        # The history does not fit this pool's window: another pool may have a bigger one. The pool is healthy, so
        # this skips it for this call without opening its breaker.
        return Verdict("skip", "history too long for this model's window")
    if status is None:
        if isinstance(exc, (anthropic.APITimeoutError, httpx.TimeoutException, TimeoutError)) or getattr(exc, "kind", "") == "timeout":
            return Verdict("switch", "timeout")
        if isinstance(exc, anthropic.APIConnectionError):
            return Verdict("switch", "connection error")
        if isinstance(exc, ModelUnavailable):
            return Verdict("switch", "model server not answering")
        return Verdict("fail", f"{type(exc).__name__}")
    after = retry_after_of(exc)
    if status == 429:
        if after is not None and after <= short_retry_s:
            return Verdict("retry", f"429, retry-after {after:g} s", 429, after)
        return Verdict("switch", f"429, retry-after {after:g} s" if after is not None else "429", 429, after)
    if status == 529 or status >= 500 or status == 408:
        return Verdict("switch", f"{status}", status, after)
    return Verdict("fail", f"{status}", status)


@dataclass
class _Breaker:
    open_until: float = 0.0
    probing: bool = False
    probe_owner: int | None = None  # the thread holding the probe: a call it makes inside that probe may use the pool
    failures: int = 0
    successes: int = 0
    last_error: str = ""
    opened_at: float = 0.0
    cooldown: float = 0.0


@dataclass
class Routed:
    """The answer, and how it was reached."""
    result: Any
    pool: Pool
    fallback_from: str = ""  # the first pool tried or skipped, when the answer came from a later one
    reason: str = ""
    retry_after: float | None = None
    attempts: int = 1
    events: list[dict[str, Any]] = field(default_factory=list)


class ModelRouter:
    """The pools are fixed (a list) or come from a `source`: a function that returns (version, pools). With a source, every
    entry point asks it first; when the version has changed the pools are rebuilt, and a pool whose name is unchanged keeps
    its breaker and its injected faults. A source that fails leaves the pools as they were."""

    def __init__(self, pools: list[Pool] | None = None, cooldown_s: float = COOLDOWN_S,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep,
                 source: Callable[[], tuple[str, list[Pool]]] | None = None, max_cooldown_s: float = MAX_COOLDOWN_S,
                 short_retry_s: float = SHORT_RETRY_S):
        if source is None and not pools:
            raise ValueError("A router needs at least one pool.")
        self.cooldown_s, self._clock, self._sleep, self._source = cooldown_s, clock, sleep, source
        self.max_cooldown_s, self.short_retry_s = max(cooldown_s, max_cooldown_s), short_retry_s
        self._lock = threading.Lock()
        self._pools: list[Pool] = []
        self._breakers: dict[str, _Breaker] = {}
        self._faults: dict[str, deque[str]] = {}
        self._by_name: dict[str, Pool] = {}
        self._version: str | None = None
        self.sync_error = ""
        if source is None:
            self._apply("", list(pools or []))
        else:
            try:
                self.sync()
            except ApiError:
                pass  # the first call reports it

    def _apply(self, version: str, pools: list[Pool]) -> None:
        with self._lock:
            names = {p.name for p in pools}
            self._breakers = {n: self._breakers.get(n) or _Breaker() for n in names}
            self._faults = {n: self._faults.get(n) or deque() for n in names}
            self._pools, self._by_name, self._version = list(pools), {p.name: p for p in pools}, version

    def sync(self) -> None:
        """Takes the source's pools if its version changed. Raises 503 only when there are no pools at all."""
        if self._source is None:
            return
        try:
            version, pools = self._source()
            if not pools:
                raise ValueError("no usable model in the catalog")
            self.sync_error = ""
        except Exception as exc:  # noqa: BLE001  (the catalog reports its own error; the last good pools stay in use)
            self.sync_error = str(exc)
            if not self._pools:
                raise ApiError(503, "model_catalog_unavailable", f"No model catalog is loaded: {exc}") from None
            return
        if version != self._version:
            self._apply(version, pools)

    @property
    def pools(self) -> list[Pool]:
        self.sync()
        return list(self._pools)

    # ----- ordering -----

    def get(self, name: str) -> Pool | None:
        self.sync()
        return self._by_name.get(name)

    def order(self, primary: str | None = None) -> list[Pool]:
        """The pools in the order to try them: the chosen primary first, then the rest as configured. A primary that is
        no longer in the catalog is ignored."""
        self.sync()
        pools, by_name = self._pools, self._by_name
        first = by_name.get(primary or "")
        return ([first] if first else []) + [p for p in pools if p is not first]

    # ----- the breaker -----

    def _b(self, name: str) -> _Breaker:
        """The pool's breaker (called with the lock held). A pool removed by a catalog change while a call is in flight
        gets a fresh one, so that call finishes cleanly; the next catalog change drops it."""
        return self._breakers.setdefault(name, _Breaker())

    def _state(self, name: str) -> str:
        b = self._b(name)
        if b.open_until == 0.0:
            return "closed"
        return "open" if self._clock() < b.open_until else "half-open"

    def _acquire(self, name: str) -> bool:
        """May a call use this pool now? A half-open pool lets one probe through at a time."""
        with self._lock:
            state, b = self._state(name), self._b(name)
            if state == "closed":
                return True
            if state == "half-open" and not b.probing:
                b.probing, b.probe_owner = True, threading.get_ident()
                return True
            # A call made inside the probe on the same thread (compacting the history before the probe's request) is
            # part of that probe. Refusing it would send the summary elsewhere, or fail it, while the pool recovers.
            return state == "half-open" and b.probe_owner == threading.get_ident()

    def usable(self, name: str) -> bool:
        """May this thread still use the pool? False once its breaker opened, including during this thread's own call."""
        return self._would_allow(name)

    def _would_allow(self, name: str) -> bool:
        with self._lock:
            state = self._state(name)
            b = self._b(name)
            return state == "closed" or (state == "half-open" and (not b.probing or b.probe_owner == threading.get_ident()))

    def _succeeded(self, name: str) -> None:
        with self._lock:
            b = self._b(name)
            b.open_until, b.probing, b.probe_owner, b.successes = 0.0, False, None, b.successes + 1

    def _failed(self, name: str, verdict: Verdict) -> None:
        """A failure that asks for a switch: open the breaker for the longer of the server's wait and ours."""
        with self._lock:
            b = self._b(name)
            wait = min(max(verdict.retry_after or 0.0, self.cooldown_s), self.max_cooldown_s)
            b.open_until = self._clock() + wait
            b.opened_at, b.cooldown, b.probing, b.probe_owner = self._clock(), wait, False, None
            b.failures += 1
            b.last_error = verdict.reason

    def _released(self, name: str) -> None:
        """A probe ended in an error that is not the pool's fault (a 400): let the next call probe again."""
        with self._lock:
            b = self._b(name)
            b.probing, b.probe_owner = False, None

    def _take_fault(self, name: str) -> ModelFault | None:
        with self._lock:
            queue = self._faults.get(name)
            return ModelFault(queue.popleft()) if queue else None

    # ----- the lab's fault injection -----

    def inject(self, name: str, kind: str, count: int = 1) -> None:
        self.sync()
        if name not in self._by_name:
            raise ValueError(f"Unknown pool {name}.")
        if kind not in FAULTS:
            raise ValueError(f"Unknown fault {kind}. Choose one of: {', '.join(FAULTS)}.")
        with self._lock:
            self._faults.setdefault(name, deque()).extend([kind] * count)

    def clear_faults(self, name: str | None = None) -> None:
        self.sync()
        with self._lock:
            for key, queue in self._faults.items():
                if name in (None, key):
                    queue.clear()

    def reset(self) -> None:
        """Close every breaker and drop every injected fault."""
        self.sync()
        with self._lock:
            for key in self._breakers:
                self._breakers[key] = _Breaker()
            for queue in self._faults.values():  # a pool removed mid-call can have a breaker but no fault queue
                queue.clear()

    def status(self) -> dict[str, Any]:
        self.sync()
        with self._lock:
            now = self._clock()
            out = []
            for p in self._pools:
                b, state = self._b(p.name), self._state(p.name)
                out.append({"name": p.name, "model": p.model, "provider": p.provider, "note": p.note,
                            "context_tokens": p.context_tokens, "state": state,
                            "retry_in_s": round(max(0.0, b.open_until - now), 1) if state == "open" else 0.0,
                            "cooldown_s": round(b.cooldown, 1), "failures": b.failures, "successes": b.successes,
                            "last_error": b.last_error, "faults": list(self._faults.get(p.name, ()))})
            return {"pools": out, "cooldown_s": self.cooldown_s, "max_cooldown_s": self.max_cooldown_s, "short_retry_s": self.short_retry_s,
                    "faults": list(FAULTS)}

    # ----- the call -----

    def call(self, send: Callable[[Pool], Any], primary: str | None = None,
             on_event: Callable[[dict[str, Any]], None] | None = None) -> Routed:
        """Calls send(pool) on the first pool that answers. send does the real request; it is not called for an injected
        fault. Raises the original error for a failure that no other pool could fix, AllPoolsFailed when none answered."""
        emit = on_event or (lambda e: None)
        order = self.order(primary)
        events: list[dict[str, Any]] = []

        def note(event: dict[str, Any]) -> None:
            events.append(event)
            emit(event)

        tried: list[str] = []
        first_name, reason, last_after = "", "", None
        skipped: tuple[str, str] | None = None  # (pool, why) for a pool passed over because its breaker was open
        too_long: BaseException | None = None  # the last 'history too long' error, raised if no pool could take it
        attempts = 0
        for index, pool in enumerate(order):
            if not self._acquire(pool.name):
                with self._lock:
                    left = max(0.0, self._b(pool.name).open_until - self._clock())
                why = f"breaker open, {left:.0f} s left" if left else "breaker half-open, a probe is in flight"
                tried.append(f"{pool.name}: {why}")
                if not first_name:
                    first_name, reason = pool.name, why
                if skipped is None:
                    skipped = (pool.name, why)
                continue
            if skipped is not None:  # moving past pools that were skipped: say so, as for a failure
                note({"type": "switch", "from": skipped[0], "to": pool.name, "reason": skipped[1], "status": None,
                      "retry_after": None, "injected": False})
                skipped = None
            retried = False
            while True:
                attempts += 1
                try:
                    fault = self._take_fault(pool.name)
                    if fault:
                        raise fault
                    result = send(pool)
                except Exception as exc:  # noqa: BLE001  (every failure is classified; unknown ones are raised again)
                    verdict = classify(exc, self.short_retry_s)
                    if verdict.action == "fail":
                        self._released(pool.name)
                        raise
                    if verdict.action == "retry" and not retried:
                        retried = True
                        note({"type": "retry", "pool": pool.name, "reason": verdict.reason,
                              "retry_after": verdict.retry_after, "injected": getattr(exc, "injected", False)})
                        self._sleep(verdict.retry_after or 0.0)
                        continue
                    if verdict.action == "skip":
                        self._released(pool.name)  # healthy: no breaker change
                        too_long = exc
                    else:
                        self._failed(pool.name, verdict)
                    tried.append(f"{pool.name}: {verdict.reason}")
                    if not first_name:
                        first_name, reason, last_after = pool.name, verdict.reason, verdict.retry_after
                    nxt = next((p for p in order[index + 1:] if self._would_allow(p.name)), None)
                    if nxt:
                        note({"type": "switch", "from": pool.name, "to": nxt.name, "reason": verdict.reason,
                              "status": verdict.status, "retry_after": verdict.retry_after,
                              "injected": getattr(exc, "injected", False)})
                    break
                except BaseException:  # interrupted or cancelled mid-call: never leave a half-open pool's probe held
                    self._released(pool.name)
                    raise
                self._succeeded(pool.name)
                switched = first_name not in ("", pool.name)
                return Routed(result, pool, first_name if switched else "", reason if switched else "", last_after,
                              attempts, events)
        if too_long is not None and all("history too long" in t for t in tried):
            raise too_long  # nothing failed: the history fits no model, which is a clearer error than "all failed"
        raise AllPoolsFailed(tried)
