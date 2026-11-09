"""Live runs of the Agent Framework workflow examples: every type of multi-agent workflow, streamed to the page.

Each model call is charged to the spending cap as it happens, and a run stops at its own budget. A workflow that stops
for a person waits on the Run until the page answers.
"""
from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace

from ..core.errors import ApiError
from ..gateways.agent_workflows import WorkflowRunner
from ..shared import PRICES
from .runs import Run, RunRegistry, RunStreamer
from .spend import SpendTracker, money

# The examples' file names, without their numbers. A test checks this list against the folder.
PATTERNS = ("sequential", "concurrent", "fan_out_fan_in_edges", "handoff", "group_chat", "maker_checker", "magentic",
            "orchestrator_workers", "routing", "plan_approve_run", "checkpoint_resume", "sub_workflow", "declarative")


class WorkflowService:
    def __init__(self, runner: WorkflowRunner | None, spend: SpendTracker, registry: RunRegistry, streamer: RunStreamer, *,
                 run_budget_usd: float, approval_timeout_s: float):
        self.runner, self.spend, self.registry, self.streamer = runner, spend, registry, streamer
        self.run_budget_usd, self.approval_timeout_s = run_budget_usd, approval_timeout_s

    def run(self, pattern: str, task: str | None) -> Iterator[str]:
        """Starts a workflow and returns its stream of events."""
        if pattern not in PATTERNS:
            raise ApiError(400, "invalid_request", f"There is no workflow called {pattern}.")
        if self.runner is None:
            raise ApiError(503, "not_configured", "Live workflows need AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENTS in .env.")
        runner, price = self.runner, PRICES.get(self.runner.model)
        if price is None:
            raise ApiError(503, "not_configured", f"There is no price listed for {runner.model} in python/common.py.")
        run = Run(self.approval_timeout_s)
        spent = [0.0]
        tokens = [0, 0]

        def on_usage(input_tokens: int, output_tokens: int) -> None:
            tokens[0], tokens[1] = tokens[0] + input_tokens, tokens[1] + output_tokens
            cost = (input_tokens * price["input"] + output_tokens * price["output"]) / 1e6
            spent[0] += self.spend.charge_usd(cost, f"Workflow {pattern}")

        def stop() -> str | None:
            if run.cancelled.is_set():
                return "The run was stopped."
            if spent[0] >= self.run_budget_usd:
                return f"The run reached its {money(self.run_budget_usd)} budget."
            return "The server's budget is used up." if self.spend.over_budget else None

        def ask(request_id: str, question: str) -> bool:
            request = SimpleNamespace(id=request_id, name="approve_plan", input={"question": question})
            return run.ask(request, "workflow", 0, "The workflow is waiting for a person.")

        def work() -> None:
            runner.run(pattern, task, emit=run.publish, ask=ask, stop=stop, on_usage=on_usage)
            run.publish({"type": "final", "cost_usd": round(spent[0], 5), "spent_usd": round(self.spend.spent_usd, 4),
                         "input_tokens": tokens[0], "output_tokens": tokens[1]})

        return self.streamer.lines(run, work)

    def approve(self, run_id: str, request_id: str, allow: bool) -> None:
        run = self.registry.get(run_id)
        if run is None or not run.answer(request_id, allow):
            raise ApiError(404, "not_found", "That workflow is no longer waiting for an answer.")
