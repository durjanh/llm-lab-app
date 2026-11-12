"""Monitoring: what the call log holds, summed up for the monitoring page. Totals, spend and calls by lab area and by
model, latency percentiles, errors and fallbacks, the recent calls, and traces (the calls one request made, in order).

All of it is arithmetic over the log (core/telemetry.py). Nothing here calls a model, so the page is free to watch.
"""
from __future__ import annotations

import math
from typing import Any

from ..core.telemetry import CallLog
from .spend import SpendTracker

RECENT_CALLS = 100
RECENT_TRACES = 25


def percentile(values: list[float], p: float) -> float | None:
    """The nearest-rank percentile: the smallest value with at least p% of the values at or below it."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]


def totals(calls: list[dict[str, Any]]) -> dict[str, Any]:
    """The sums for a set of calls. Latency counts only the calls that were timed and answered."""
    timed = [c["latency_ms"] for c in calls if c.get("latency_ms") is not None and c["status"] == "ok"]
    return {
        "calls": len(calls),
        "cost_usd": round(sum(c["cost_usd"] for c in calls), 6),
        "input_tokens": sum(c["input_tokens"] for c in calls),
        "output_tokens": sum(c["output_tokens"] for c in calls),
        "cache_read_tokens": sum(c["cache_read_tokens"] for c in calls),
        "errors": sum(c["status"] == "error" for c in calls),
        "fallbacks": sum(bool(c.get("fallback")) for c in calls),
        "timed": len(timed),
        "p50_ms": percentile(timed, 50),
        "p95_ms": percentile(timed, 95),
    }


def grouped(calls: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    """Totals for each value of one field (area or model), the most expensive first."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for c in calls:
        groups.setdefault(c.get(key) or "unknown", []).append(c)
    rows = [{key: name, **totals(group)} for name, group in groups.items()]
    return sorted(rows, key=lambda r: (-r["cost_usd"], -r["calls"], r[key]))


def traces(calls: list[dict[str, Any]], limit: int = RECENT_TRACES) -> list[dict[str, Any]]:
    """The calls each request made, in order, newest request first. A call's span runs from when it started to when
    it ended; one that was not timed has only the moment it was charged."""
    by_trace: dict[str, list[dict[str, Any]]] = {}
    for c in calls:
        if c.get("trace"):
            by_trace.setdefault(c["trace"], []).append(c)
    out = []
    for trace, group in by_trace.items():
        spans = []
        for c in group:
            start = c["started"] if c.get("started") is not None else c["at"]
            end = start + c["latency_ms"] / 1000 if c.get("latency_ms") is not None else c["at"]
            spans.append((start, end, c))
        begin, finish = min(s[0] for s in spans), max(s[1] for s in spans)
        out.append({
            "trace": trace, "area": group[0]["area"], "route": group[0]["route"], "started": round(begin, 3),
            "duration_ms": round((finish - begin) * 1000), **totals(group),
            "spans": [{"id": c["id"], "model": c["model"], "kind": c["kind"], "status": c["status"],
                       "error": c.get("error"), "fallback": bool(c.get("fallback")),
                       "offset_ms": round((start - begin) * 1000),
                       "latency_ms": c.get("latency_ms"), "input_tokens": c["input_tokens"],
                       "output_tokens": c["output_tokens"], "cost_usd": c["cost_usd"]}
                      for start, _end, c in sorted(spans, key=lambda s: s[0])],
        })
    return sorted(out, key=lambda t: -t["started"])[:limit]


class ObservabilityService:
    def __init__(self, log: CallLog, spend: SpendTracker):
        self.log, self.spend = log, spend

    def overview(self, scope: str = "session") -> dict[str, Any]:
        """Everything the monitoring page shows. scope 'session' is this start of the server; 'all' adds the calls
        kept from earlier starts."""
        kept = self.log.calls()
        calls = kept if scope == "all" else [c for c in kept if c.get("run") == self.log.run]
        return {
            "scope": "all" if scope == "all" else "session",
            "session": {"started_at": round(self.log.started_at, 3), "spent_usd": round(self.spend.spent_usd, 6),
                        "budget_usd": self.spend.budget_usd, "charges": self.spend.calls},
            "kept": {"calls": len(kept), "limit": self.log.limit, "oldest_at": kept[0]["at"] if kept else None,
                     "from_earlier_starts": sum(c.get("run") != self.log.run for c in kept)},
            "totals": totals(calls),
            "by_area": grouped(calls, "area"),
            "by_model": grouped(calls, "model"),
            "traces": traces(calls),
            "calls": list(reversed(calls[-RECENT_CALLS:])),
        }

    def clear(self) -> dict[str, Any]:
        """Empties the log and its file. The session's spend is not changed: the budget still counts it."""
        self.log.clear()
        return self.overview()
