"""Plan, approve, then run: a real pause for a person.

The planner proposes steps and the workflow stops at request_info, holding its state, until someone answers. Nothing
that changes anything can run before that, because the only agent with the send tool is on the far side of the gate.
This is plan mode in Claude Code, built as a workflow. Run without --yes to answer it yourself.

    python 10_plan_approve_run.py
"""
from __future__ import annotations

from dataclasses import dataclass

from agent_framework import Agent, Executor, WorkflowBuilder, WorkflowContext, handler, response_handler, tool
from pydantic import BaseModel
from typing_extensions import Never

from _wf import Lab, main

TITLE = "Plan, approve, run"
TASK = "Three customers on the late-delivery list need telling that their e-bikes will now arrive next Friday."
CUSTOMERS = ["Asha", "Ben", "Chloe"]
SENT: list[str] = []


@tool
def send_email(customer: str, body: str) -> str:
    """Send one email to a customer. This example only records it."""
    SENT.append(customer)
    return f"Sent to {customer}."


class Plan(BaseModel):
    steps: list[str]


@dataclass
class PlanReview:
    text: str


class Planner(Executor):
    def __init__(self, agent: Agent):
        super().__init__(id="planner")
        self.agent = agent

    @handler
    async def plan(self, task: str, ctx: WorkflowContext[str]) -> None:
        reply = await self.agent.run(f"{task}\nCustomers: {CUSTOMERS}", options={"response_format": Plan})
        await ctx.send_message(f"Task: {task}\nPlan:\n" + "\n".join(f"- {s}" for s in reply.value.steps))


class Gate(Executor):
    """Stops the workflow until a person answers. Its state is held, so this could wait for days with a checkpoint."""

    @handler
    async def ask(self, plan: str, ctx: WorkflowContext) -> None:
        await ctx.request_info(PlanReview(text=plan), bool)

    @response_handler
    async def answered(self, request: PlanReview, approved: bool, ctx: WorkflowContext[str, str]) -> None:
        if approved:
            await ctx.send_message(request.text)
        else:
            await ctx.yield_output("Plan rejected. Nothing was sent.")


class Doer(Executor):
    def __init__(self, agent: Agent):
        super().__init__(id="doer")
        self.agent = agent

    @handler
    async def run_plan(self, plan: str, ctx: WorkflowContext[Never, str]) -> None:
        SENT.clear()
        reply = await self.agent.run(plan)
        await ctx.yield_output(f"{reply.text}\n\nEmails actually sent: {SENT}")


def build(lab: Lab):
    planner = Planner(lab.agent("planner", "Plan the work as a few short steps. You can't do any of it yourself."))
    gate = Gate(id="approval_gate")
    doer = Doer(lab.agent("doer", "Carry out the plan with your tool, one short email each. Then say what you did.",
                          tools=[send_email]))
    return WorkflowBuilder(start_executor=planner, name="plan_approve_run").add_edge(planner, gate).add_edge(gate, doer).build()


if __name__ == "__main__":
    main(__file__)
