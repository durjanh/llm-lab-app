"""Sub-workflows: a workflow used as one step of another.

WorkflowExecutor wraps a finished workflow so it can be a node in a bigger one. The outer graph sees one step, and the
team inside can be built and tested on its own. MedAssist's hosted inbox shows the related move, workflow.as_agent().

    python 12_sub_workflow.py
"""
from __future__ import annotations

from agent_framework import Agent, Executor, WorkflowBuilder, WorkflowContext, WorkflowExecutor, handler
from typing_extensions import Never

from _wf import SHOP, Lab, main

TITLE = "Sub-workflow"
TASK = f"A one-sentence website banner for {SHOP} about free helmet fitting in June."


class Step(Executor):
    def __init__(self, id: str, agent: Agent, lab: Lab, last: bool = False):
        super().__init__(id=id)
        self.agent, self.lab, self.last = agent, lab, last

    @handler
    async def work(self, text: str, ctx: WorkflowContext[str, str]) -> None:
        reply = (await self.agent.run(text)).text
        self.lab.trace.event("note", text=f"Inside review_team, {self.id} says: {reply}")
        await (ctx.yield_output(reply) if self.last else ctx.send_message(reply))


class Brief(Executor):
    @handler
    async def brief(self, task: str, ctx: WorkflowContext[str]) -> None:
        await ctx.send_message(f"Brief: {task}")


class Publish(Executor):
    @handler
    async def publish(self, text: str, ctx: WorkflowContext[Never, str]) -> None:
        await ctx.yield_output(f"Published: {text}")


def build(lab: Lab):
    writer = Step("writer", lab.agent("writer", "Write what the brief asks. Return only that."), lab)
    critic = Step("critic", lab.agent("critic", "Improve this and return only the improved text."), lab, last=True)
    team = WorkflowBuilder(start_executor=writer, name="review_team").add_edge(writer, critic).build()
    brief, inner, publish = Brief(id="brief"), WorkflowExecutor(team, id="review_team"), Publish(id="publish")
    return WorkflowBuilder(start_executor=brief, name="banner").add_edge(brief, inner).add_edge(inner, publish).build()


if __name__ == "__main__":
    main(__file__)
