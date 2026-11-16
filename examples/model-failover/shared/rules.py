"""The rules both examples share with the /model-failover page: which failures switch model, a circuit breaker, and when to
compact. Plain Python, no framework, so it is the same in Agent Framework and LangGraph.

Error table (classify): a 429 with a retry-after of 2 s or less is retried once on the same model; a 429 with a long or no
retry-after, a 529, any 5xx, a timeout or a dropped connection opens the breaker and switches; a 400, 401, 403, 404, 413
or 422 is never switched (the next model would fail the same way).

Compaction settings use the lab's names: MODEL_FAILOVER_COMPACT_AT (a fraction of the current model's window, 0.7),
MODEL_FAILOVER_COMPACT_MAX_TOKENS (an absolute ceiling, 60000; the smaller counts), MODEL_FAILOVER_KEEP_RECENT (turns kept
word for word, 4) and MODEL_FAILOVER_COMPACT_MODEL (an optional override of the model that writes the summary; by default the compact_model of
config/model-failover.json, read by catalog.py).
"""
from __future__ import annotations

import math
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

SHORT_RETRY_S = 2.0
COOLDOWN_S = 30.0


@dataclass(frozen=True)
class Verdict:
    action: str  # retry | switch | fail
    reason: str
    retry_after: float | None = None


def _status(exc: BaseException) -> int | None:
    code = getattr(exc, "status_code", None)
    if code is None:
        code = getattr(getattr(exc, "response", None), "status_code", None)
    return code if isinstance(code, int) else None


def retry_after_of(exc: BaseException) -> float | None:
    if hasattr(exc, "retry_after") and isinstance(exc.retry_after, (int, float)):  # an injected fault
        return float(exc.retry_after)
    headers = getattr(getattr(exc, "response", None), "headers", None)
    try:
        return max(0.0, float(headers.get("retry-after"))) if headers is not None and headers.get("retry-after") else None
    except (TypeError, ValueError):
        return None


def classify(exc: BaseException) -> Verdict:
    status = _status(exc)
    if status is None:
        name = type(exc).__name__.lower()
        if isinstance(exc, (TimeoutError, ConnectionError)) or "timeout" in name or "connection" in name:
            return Verdict("switch", "timeout or connection error")
        return Verdict("fail", type(exc).__name__)
    after = retry_after_of(exc)
    if status == 429:
        if after is not None and after <= SHORT_RETRY_S:
            return Verdict("retry", f"429, retry-after {after:g} s", after)
        return Verdict("switch", f"429, retry-after {after:g} s" if after is not None else "429", after)
    if status in (408, 529) or status >= 500:
        return Verdict("switch", str(status), after)
    return Verdict("fail", str(status))


class Fault(Exception):
    """An injected failure, for the demo and the tests. It carries a status code like a real SDK error."""

    def __init__(self, status_code: int | None, retry_after: float | None = None):
        super().__init__(f"injected {status_code or 'timeout'}")
        self.status_code, self.retry_after = status_code, retry_after


class CircuitBreaker:
    """Closed; open for a cool-down after a failure that asks for a switch; half-open after it, with one probe at a time."""

    def __init__(self, cooldown_s: float = COOLDOWN_S, clock: Callable[[], float] = time.monotonic):
        self.cooldown_s, self._clock = cooldown_s, clock
        self._open_until, self._probing = 0.0, False
        self._lock = threading.Lock()

    @property
    def state(self) -> str:
        if not self._open_until:
            return "closed"
        return "open" if self._clock() < self._open_until else "half-open"

    def allow(self) -> bool:
        with self._lock:
            state = self.state
            if state == "closed":
                return True
            if state == "half-open" and not self._probing:
                self._probing = True
                return True
            return False

    def success(self) -> None:
        with self._lock:
            self._open_until, self._probing = 0.0, False

    def failure(self, retry_after: float | None = None) -> None:
        with self._lock:
            self._open_until = self._clock() + max(self.cooldown_s, retry_after or 0.0)
            self._probing = False

    def release(self) -> None:
        with self._lock:
            self._probing = False


# ----- compaction -----

def _catalog_compact_model() -> str:
    import catalog  # shared/catalog.py, on the path beside this file
    return catalog.compact_model()


@dataclass(frozen=True)
class CompactSettings:
    at: float = 0.7
    max_tokens: int = 60000
    keep_recent: int = 4
    model: str = ""  # the summary model: from_env fills it from config/model-failover.json

    @classmethod
    def from_env(cls) -> "CompactSettings":
        get = os.environ.get
        return cls(min(0.95, max(0.2, float(get("MODEL_FAILOVER_COMPACT_AT") or cls.at))),
                   max(4000, int(get("MODEL_FAILOVER_COMPACT_MAX_TOKENS") or cls.max_tokens)),
                   min(20, max(1, int(get("MODEL_FAILOVER_KEEP_RECENT") or cls.keep_recent))),
                   get("MODEL_FAILOVER_COMPACT_MODEL") or _catalog_compact_model())

    def threshold(self, window: int) -> int:
        return int(min(self.at * window, self.max_tokens))


def estimate_tokens(text: str) -> int:
    """Characters over four, plus a ten per cent margin: offline, so it works while an API is failing."""
    return math.ceil(len(text) / 4 * 1.1)


def compaction_cut(turns: list[int], keep_recent: int) -> int | None:
    """Given the turn number of each stored message in order, the index of the first message to keep word for word, or
    None. Always the start of a turn, so a tool call is never parted from its result."""
    distinct = sorted(set(turns))
    if len(distinct) <= keep_recent:
        return None
    first = distinct[-keep_recent]
    return turns.index(first)


def usable_summary(text: str | None, finish: Any = None) -> bool:
    """A summary replaces history only if it has text and was not refused or cut off."""
    return bool(text and text.strip()) and str(finish or "").lower() not in ("refusal", "max_tokens", "length", "content_filter")
