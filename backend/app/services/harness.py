"""Live runs of the ten-tool harness in python/11_harness_loop.py."""
from __future__ import annotations

import shutil
import time
from collections.abc import Iterator
from typing import Any

from ..core.errors import ApiError
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, harness_script as H
from .runs import Run, RunRegistry, RunStreamer
from .spend import SpendTracker

# In the browser every bash command asks a person first. The deny rules still apply before anyone is asked.
WEB_PERMISSIONS = {**H.PERMISSIONS,
                   "allow": [r for r in H.PERMISSIONS["allow"] if not r.startswith("bash(")] + ["bash(restart)"]}


class HarnessService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, registry: RunRegistry, streamer: RunStreamer, *,
                 run_budget_usd: float, approval_timeout_s: float, max_turns: int = 10, tool_latency_s: float = 0.3):
        self.claude, self.spend, self.registry, self.streamer = claude, spend, registry, streamer
        self.run_budget_usd, self.approval_timeout_s = run_budget_usd, approval_timeout_s
        self.max_turns, self.tool_latency_s = max_turns, tool_latency_s

    def run(self, scenario: str, number: int, task: str | None, model: str | None, effort: str) -> Iterator[str]:
        """Starts a run and returns its stream of events."""
        model = model or DEFAULT_MODEL
        task = task or H.SCENARIOS[scenario].format(n=number, n2=number + 5, n3=number * 30)
        run = Run(self.approval_timeout_s)
        harness = self._build_harness(run, model, effort)
        main_agent = H.build_agents(model, self.max_turns)

        def work() -> None:
            run.publish({"type": "task", "task": task, "model": model, "tools": [t.name for t in main_agent.tools]})
            start = time.perf_counter()
            try:
                answer, outcome = harness.run_agent(main_agent, task), "done"
            except H.StopRun as exc:
                answer, outcome = None, f"stopped by the harness: {exc}"
            finally:
                shutil.rmtree(harness.sandbox, ignore_errors=True)
            run.publish({"type": "final", "answer": answer, "outcome": outcome, "usage": dict(harness.usage),
                         "tool_calls": harness.tool_calls, "tool_seconds": round(harness.tool_seconds, 2),
                         "wall_seconds": round(time.perf_counter() - start, 2), "cost": round(harness.spent, 4),
                         "spent_usd": round(self.spend.spent_usd, 4)})

        return self.streamer.lines(run, work)

    def approve(self, run_id: str, tool_use_id: str, allow: bool) -> None:
        run = self.registry.get(run_id)
        if run is None or not run.answer(tool_use_id, allow):
            raise ApiError(404, "not_found", "That command is no longer waiting for an answer.")

    def _build_harness(self, run: Run, model: str, effort: str) -> Any:
        """The script's Harness, wired to this run: events to the page, prompts to the page, spend to the tracker."""
        harness = H.Harness(self.claude.client, model, effort=effort, latency=self.tool_latency_s,
                            budget=min(self.run_budget_usd, self.spend.remaining_usd),
                            emit=run.publish, approve=run.ask, permissions=WEB_PERMISSIONS,
                            on_response=lambda resp: self.spend.charge(resp, model))
        harness.cancelled = run.cancelled  # closing the page stops the agents
        return harness
