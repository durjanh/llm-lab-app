"""Keep calling a model API when it says "not now": backoff, a circuit breaker per endpoint, and failover.

Companion to the Rate limits lab. Three patterns that work together:

- Backoff with full jitter that honours the server's Retry-After, so clients spread out instead of
  retrying in step, and never retry sooner than the server said would work.
- A circuit breaker per endpoint. After repeated failures, or a 429 that names a wait, it stops sending
  to that endpoint until the wait is over, so requests stop paying for timeouts against a dead region.
- Failover through an ordered list of endpoints: other regions or deployments of the same model first,
  then a smaller model as a last resort, used only for tasks your evals show it handles.

Errors that will not get better by waiting (a bad request, a spent monthly budget) are raised at once.
Build each client with max_retries=0 so these retries replace the SDK's, rather than run on top of them.

    from resilience import CircuitBreaker, Endpoint, ResilientCaller
    caller = ResilientCaller([
        Endpoint("primary", anthropic.Anthropic(max_retries=0), "claude-sonnet-5-5"),
        Endpoint("small model", anthropic.Anthropic(max_retries=0), "claude-haiku-5-5", degraded=True),
    ], deadline_s=30)
    outcome = caller.create(max_tokens=1024, messages=[...])
"""
from __future__ import annotations

import random
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import anthropic

# 408 timeout, 409 conflict, 429 rate limit, 5xx server errors, 529 overloaded: worth trying again or elsewhere.
RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504, 529}


def retry_after_s(exc: BaseException) -> float | None:
    """Seconds the server asked the caller to wait, from retry-after-ms (Azure) or retry-after. None if it said nothing."""
    response = getattr(exc, "response", None)
    if response is None:
        return None
    for name, scale in (("retry-after-ms", 1000.0), ("retry-after", 1.0)):
        value = response.headers.get(name)
        if value:
            try:
                return max(0.0, float(value) / scale)
            except ValueError:
                pass  # retry-after can also be an HTTP date; treat it as unknown
    return None


def spend_cap_reached(exc: BaseException) -> bool:
    """A 429 for a used-up monthly spend cap. It has no retry-after, and every retry fails until the month ends."""
    body = getattr(exc, "body", None)
    error = body.get("error") if isinstance(body, dict) else None
    details = error.get("details") if isinstance(error, dict) else None
    return isinstance(details, dict) and details.get("error_code") == "enforced_spend_limit_reached"


def is_retryable(exc: BaseException) -> bool:
    """True for failures that may succeed later or somewhere else: rate limits, overload, server errors, timeouts."""
    if isinstance(exc, anthropic.APIConnectionError):  # includes APITimeoutError
        return True
    if isinstance(exc, anthropic.APIStatusError):
        return exc.status_code in RETRYABLE_STATUS and not spend_cap_reached(exc)
    return False


def backoff_s(attempt: int, base_s: float = 0.5, cap_s: float = 20.0, rng: random.Random | None = None) -> float:
    """Exponential backoff with full jitter: a random wait between 0 and base * 2^attempt, capped.

    The randomness matters as much as the growth. Without it, every client that was refused at the same
    moment comes back at the same moment, and is refused again.
    """
    return (rng or random).uniform(0, min(cap_s, base_s * 2 ** attempt))


class CircuitBreaker:
    """Stops sending to an endpoint that keeps failing, then lets traffic through again after a pause.

    Closed: requests flow. Open: requests skip this endpoint until `open_until`. Half-open: the pause is
    over and one trial request may go; success closes the circuit, failure opens it again. A 429 that
    carries Retry-After opens it for exactly that long, as API Management's breaker does when it is set
    to accept Retry-After.
    """

    def __init__(self, failure_threshold: int = 3, cooldown_s: float = 30.0, clock: Callable[[], float] = time.monotonic):
        self.failure_threshold, self.cooldown_s, self.clock = failure_threshold, cooldown_s, clock
        self.failures = 0
        self.open_until = 0.0
        self._tripped = False  # opened at least once since the last success: the next request is a trial
        self._trial_running = False
        self._lock = threading.Lock()

    @property
    def state(self) -> str:
        if self.clock() < self.open_until:
            return "open"
        return "half-open" if self._tripped else "closed"

    def allow(self) -> bool:
        """Whether a request may go to this endpoint now. In half-open, only one request goes at a time."""
        with self._lock:
            if self.clock() < self.open_until:
                return False
            if self._tripped:
                if self._trial_running:
                    return False
                self._trial_running = True
            return True

    def success(self) -> None:
        with self._lock:
            self.failures, self.open_until, self._tripped, self._trial_running = 0, 0.0, False, False

    def failure(self, retry_after: float | None = None) -> None:
        with self._lock:
            self.failures += 1
            self._trial_running = False
            if retry_after is not None:
                self._open(retry_after)
            elif self._tripped or self.failures >= self.failure_threshold:
                self._open(self.cooldown_s)

    def seconds_until_closed(self) -> float:
        return max(0.0, self.open_until - self.clock())

    def _open(self, seconds: float) -> None:
        self.open_until = max(self.open_until, self.clock() + seconds)
        self._tripped = True


@dataclass
class Endpoint:
    """One place a request can go: a client for a region, deployment or account, and the model to ask for there."""
    name: str
    client: Any
    model: str
    degraded: bool = False  # a smaller or cheaper model: say so when it answers
    breaker: CircuitBreaker = field(default_factory=CircuitBreaker)


@dataclass
class Outcome:
    message: Any
    endpoint: Endpoint
    attempts: int
    waited_s: float


class AllEndpointsBusy(RuntimeError):
    """Every endpoint is refusing and the deadline is near. Queue the work, or tell the person and try later."""


class ResilientCaller:
    """Sends a Messages request to the first endpoint whose circuit is closed, failing over and backing off as needed.

    `deadline_s` is how long a person will wait. When the next useful attempt would land after it, the
    caller gives up at once with AllEndpointsBusy instead of sleeping past it: an interactive request
    should fail fast, and background work should go back on a queue.
    """

    def __init__(self, endpoints: list[Endpoint], deadline_s: float = 60.0, max_attempts: int = 8,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
                 rng: random.Random | None = None, log: Callable[[str], None] | None = None):
        if not endpoints:
            raise ValueError("At least one endpoint is needed.")
        self.endpoints, self.deadline_s, self.max_attempts = endpoints, deadline_s, max_attempts
        self.sleep, self.clock, self.rng, self.log = sleep, clock, rng or random.Random(), log or (lambda _: None)

    def create(self, **params: Any) -> Outcome:
        start = self.clock()
        attempts, waits = 0, 0
        tried: set[str] = set()  # endpoints already tried since the last wait
        last_error: BaseException | None = None
        while True:
            endpoint = next((e for e in self.endpoints if e.name not in tried and e.breaker.allow()), None)
            if endpoint is None or attempts >= self.max_attempts:
                if attempts >= self.max_attempts:
                    raise AllEndpointsBusy(f"Gave up after {attempts} attempts.") from last_error
                # Nothing to try now: wait for the first circuit to close, or back off, whichever is longer.
                reopen = min(e.breaker.seconds_until_closed() for e in self.endpoints)
                wait = max(reopen, backoff_s(waits, rng=self.rng))
                left = self.deadline_s - (self.clock() - start)
                if wait >= left:
                    raise AllEndpointsBusy(f"Every endpoint is busy, and the next try would be {wait:.1f} s away, "
                                           f"past the {self.deadline_s:.0f} s deadline.") from last_error
                self.log(f"all endpoints busy: waiting {wait:.2f} s")
                self.sleep(wait)
                waits += 1
                tried.clear()
                continue
            attempts += 1
            tried.add(endpoint.name)
            try:
                message = endpoint.client.messages.create(model=endpoint.model, **params)
            except Exception as exc:
                if not is_retryable(exc):
                    endpoint.breaker.success()  # the endpoint answered; the request itself is the problem
                    raise
                last_error = exc
                endpoint.breaker.failure(retry_after_s(exc))
                self.log(f"{endpoint.name}: {describe(exc)}; circuit {endpoint.breaker.state}")
                continue
            endpoint.breaker.success()
            return Outcome(message, endpoint, attempts, self.clock() - start)


def describe(exc: BaseException) -> str:
    if isinstance(exc, anthropic.APITimeoutError):
        return "timed out"
    if isinstance(exc, anthropic.APIConnectionError):
        return "could not connect"
    if isinstance(exc, anthropic.APIStatusError):
        wait = retry_after_s(exc)
        return f"{exc.status_code}" + (f", retry after {wait:g} s" if wait is not None else "")
    return type(exc).__name__
