"""Rate limits: what happens when a spike of requests runs into a token limit, and what each defence buys.

Companion to the Rate limits lab. Starts fake Claude endpoints on this machine, each with a token-bucket
rate limit like the real API's, and sends the same spike of requests through them several ways: with no
retries, with the SDK's own retries, then with resilience.py adding backoff, a second region, a smaller
model and a circuit breaker. The fakes answer 429 with retry-after (and retry-after-ms, as Azure OpenAI
does), so the real SDK raises its real RateLimitError and the code is the code you would ship.

No API key is needed and nothing is billed: no request leaves this machine.

    python 13_rate_limits.py
    python 13_rate_limits.py --requests 40 --deadline 8 --verbose
    python 13_rate_limits.py --only breaker
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anthropic

from common import run
from resilience import AllEndpointsBusy, CircuitBreaker, Endpoint, ResilientCaller

PROMPT = "Summarise this complaint in one line. " + "The parcel arrived late and damaged. " * 160  # about 1,500 tokens


class FakeRegion:
    """A local stand-in for one Claude endpoint. Its limit is a token bucket, as on the Claude API:
    capacity refills continuously, and a request is refused when its input tokens would overdraw it."""

    def __init__(self, name: str, model: str, tokens_per_s: float, burst_s: float = 2.0, latency_s: float = 0.4,
                 down: bool = False, hang_s: float = 6.0):
        self.name, self.model, self.rate, self.capacity = name, model, tokens_per_s, tokens_per_s * burst_s
        self.latency_s, self.down, self.hang_s = latency_s, down, hang_s
        self.level, self.updated = self.capacity, time.monotonic()
        self.calls = self.limited = self.failed = 0
        self.lock = threading.Lock()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def take(self, tokens: int) -> float | None:
        """Spends tokens from the bucket. None when allowed, otherwise the seconds until there would be enough."""
        with self.lock:
            now = time.monotonic()
            self.level = min(self.capacity, self.level + (now - self.updated) * self.rate)
            self.updated = now
            self.calls += 1
            if self.level >= tokens:
                self.level -= tokens
                return None
            self.limited += 1
            return (tokens - self.level) / self.rate

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        region = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: object) -> None:
                pass

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                tokens = max(1, len(json.dumps(body.get("messages", []))) // 4)
                if region.down:  # an outage: the request hangs, then fails
                    with region.lock:
                        region.calls += 1
                        region.failed += 1
                    time.sleep(region.hang_s)
                    return self.reply(529, error("overloaded_error", "Overloaded"))
                wait = region.take(tokens)
                if wait is not None:
                    return self.reply(429, error("rate_limit_error", "Input tokens per minute exceeded."),
                                      {"retry-after": str(math.ceil(wait)), "retry-after-ms": str(math.ceil(wait * 1000))})
                time.sleep(region.latency_s)
                self.reply(200, {"id": "msg_fake", "type": "message", "role": "assistant", "model": body.get("model"),
                                 "content": [{"type": "text", "text": f"Answered by {region.name}."}],
                                 "stop_reason": "end_turn", "stop_sequence": None,
                                 "usage": {"input_tokens": tokens, "output_tokens": 8}})

            def reply(self, status: int, payload: dict, headers: dict[str, str] | None = None) -> None:
                data = json.dumps(payload).encode()
                try:
                    self.send_response(status)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(data)))
                    for name, value in (headers or {}).items():
                        self.send_header(name, value)
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the client timed out and hung up first, as it should against a dead region

        return Handler


def error(kind: str, message: str) -> dict:
    return {"type": "error", "error": {"type": kind, "message": message}}


@dataclass
class Scenario:
    key: str
    title: str
    lesson: str
    regions: Callable[[], list[FakeRegion]]
    sdk_retries: int | None = None  # set: call the first region with the plain SDK client and this many retries
    breaker: bool = True
    steady: bool = False  # arrivals spread out, as during an outage that lasts, instead of one spike


@dataclass
class Result:
    ok: int = 0
    degraded: int = 0
    failed: int = 0
    latencies: list[float] = field(default_factory=list)


def regions(primary_down: bool = False, secondary: bool = True, small: bool = True) -> Callable[[], list[FakeRegion]]:
    def build() -> list[FakeRegion]:
        out = [FakeRegion("primary region", "claude-sonnet-5-5", tokens_per_s=3000, down=primary_down)]
        if secondary:
            out.append(FakeRegion("second region", "claude-sonnet-5-5", tokens_per_s=2000))
        if small:
            out.append(FakeRegion("smaller model", "claude-haiku-5-5", tokens_per_s=4000, latency_s=0.2))
        return out
    return build


SCENARIOS = [
    Scenario("none", "No retries", "Every 429 reaches the user.",
             regions(secondary=False, small=False), sdk_retries=0),
    Scenario("sdk", "The SDK's own retries (2)", "Honours retry-after, but gives up after two tries on one endpoint.",
             regions(secondary=False, small=False), sdk_retries=2),
    Scenario("backoff", "Backoff + Retry-After", "Spreads retries out until the deadline; one region still runs out.",
             regions(secondary=False, small=False)),
    Scenario("failover", "+ second region", "Another region's quota takes the overflow at once.",
             regions(small=False)),
    Scenario("smaller", "+ smaller model last", "The rest is answered by the smaller model, marked as such.",
             regions()),
    Scenario("down", "Primary down, no breaker", "Every request first waits for the dead region to time out.",
             regions(primary_down=True), breaker=False, steady=True),
    Scenario("breaker", "Primary down, with breaker", "After three timeouts the dead region is skipped, with one trial "
             "request every few seconds to see if it is back.", regions(primary_down=True), steady=True),
]
STEADY_GAP_S = 0.4  # the outage scenarios' arrivals: about 12 seconds of steady traffic


def run_scenario(s: Scenario, requests: int, gap_s: float, deadline_s: float, verbose: bool) -> tuple[Result, list[FakeRegion], float]:
    fakes = s.regions()
    timeout = 3.0  # seconds before a hung request gives up; real clients often wait 30 or more
    log = (lambda line: print(f"    {line}")) if verbose else None
    if s.sdk_retries is not None:
        client = anthropic.Anthropic(api_key="not-needed", base_url=fakes[0].url, max_retries=s.sdk_retries, timeout=timeout)
    else:
        endpoints = [Endpoint(f.name, anthropic.Anthropic(api_key="not-needed", base_url=f.url, max_retries=0, timeout=timeout),
                              f.model, degraded=f.model != fakes[0].model,
                              breaker=CircuitBreaker(failure_threshold=3 if s.breaker else 10**9, cooldown_s=5.0))
                     for f in fakes]
        caller = ResilientCaller(endpoints, deadline_s=deadline_s, max_attempts=12, log=log)

    result, lock = Result(), threading.Lock()
    gap_s = STEADY_GAP_S if s.steady else gap_s

    def one(i: int) -> None:
        time.sleep(i * gap_s)  # a spike: requests arrive faster than one region's limit allows
        start = time.monotonic()
        degraded = False
        try:
            if s.sdk_retries is not None:
                client.messages.create(model=fakes[0].model, max_tokens=64, messages=[{"role": "user", "content": PROMPT}])
            else:
                degraded = caller.create(max_tokens=64, messages=[{"role": "user", "content": PROMPT}]).endpoint.degraded
            ok = time.monotonic() - start <= deadline_s
        except (anthropic.APIError, AllEndpointsBusy) as exc:
            ok = False
            if verbose:
                print(f"    request {i}: {type(exc).__name__}")
        with lock:
            if ok:
                result.ok += 1
                result.degraded += degraded
                result.latencies.append(time.monotonic() - start)
            else:
                result.failed += 1

    started = time.monotonic()
    threads = [threading.Thread(target=one, args=(i,)) for i in range(requests)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.monotonic() - started
    for f in fakes:
        f.close()
    return result, fakes, wall


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--requests", type=int, default=30)
    parser.add_argument("--gap", type=float, default=0.12, help="seconds between arrivals (default: 0.12)")
    parser.add_argument("--deadline", type=float, default=10.0, help="seconds a person will wait (default: 10)")
    parser.add_argument("--only", choices=[s.key for s in SCENARIOS], help="run one scenario")
    parser.add_argument("--verbose", action="store_true", help="print every failover, wait and failure")
    args = parser.parse_args()

    print(f"{args.requests} requests of about 1,500 input tokens, one every {args.gap:g} s, each with a "
          f"{args.deadline:g} s deadline.\nPrimary region: 3,000 tokens/s, second region 2,000, smaller model 4,000. "
          f"The two outage scenarios send them one every {STEADY_GAP_S:g} s instead. All local fakes: nothing is billed.\n")
    rows = []
    for s in SCENARIOS:
        if args.only and s.key != args.only:
            continue
        print(f"{s.title}…", flush=True)
        r, fakes, wall = run_scenario(s, args.requests, args.gap, args.deadline, args.verbose)
        calls = sum(f.calls for f in fakes)
        limited = sum(f.limited for f in fakes)
        failed_calls = sum(f.failed for f in fakes)
        p50 = statistics.median(r.latencies) if r.latencies else float("nan")
        p95 = sorted(r.latencies)[max(0, math.ceil(0.95 * len(r.latencies)) - 1)] if r.latencies else float("nan")
        rows.append((s, r, calls, limited, failed_calls, p50, p95, wall))

    print(f"\n{'':30} {'answered':>9} {'by small':>9} {'failed':>7} {'p50 s':>6} {'p95 s':>6} {'calls':>6} {'429s':>5} {'errors':>7}")
    for s, r, calls, limited, failed_calls, p50, p95, _ in rows:
        print(f"{s.title:30} {r.ok:>9} {r.degraded:>9} {r.failed:>7} {p50:>6.1f} {p95:>6.1f} {calls:>6} {limited:>5} {failed_calls:>7}")
    print()
    for s, *_ in rows:
        print(f"{s.title}: {s.lesson}")
    print("\n'answered' counts answers within the deadline. 'calls' is every request the endpoints received, retries included.")


if __name__ == "__main__":
    run(main)
