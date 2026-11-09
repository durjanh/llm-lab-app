"""Fan-out and fan-in edges, wired by hand: the graph underneath Concurrent.

add_fan_out_edges sends one message to every target. add_fan_in_edges waits for all of them and delivers a list. Wiring
it yourself lets branches be different kinds of work: here one reviewer is plain code and two are models.

    python 03_fan_out_fan_in_edges.py
"""
from __future__ import annotations

from dataclasses import dataclass

from agent_framework import Agent, Executor, WorkflowBuilder, WorkflowContext, handler
from typing_extensions import Never

from _wf import Lab, main

TITLE = "Fan-out and fan-in edges"
TASK = ("Hi Sam, sorry your e-bike battery arrived damaged. We guarantee a replacement within two days, "
        "and you do not need to return the old one. Thanks for your patience.")
BANNED = ("guarantee", "always", "never")
MAX_WORDS = 40


@dataclass
class Finding:
    reviewer: str
    text: str


class Start(Executor):
    @handler
    async def start(self, draft: str, ctx: WorkflowContext[str]) -> None:
        await ctx.send_message(draft)


class RuleCheck(Executor):
    """No model here: rules that code can check should be checked by code."""

    @handler
    async def check(self, draft: str, ctx: WorkflowContext[Finding]) -> None:
        words, banned = len(draft.split()), [w for w in BANNED if w in draft.lower()]
        await ctx.send_message(Finding(self.id, f"{words} words (limit {MAX_WORDS}); banned words: {banned or 'none'}."))


class Reviewer(Executor):
    def __init__(self, id: str, agent: Agent):
        super().__init__(id=id)
        self.agent = agent

    @handler
    async def review(self, draft: str, ctx: WorkflowContext[Finding]) -> None:
        await ctx.send_message(Finding(self.id, (await self.agent.run(draft)).text))


class Join(Executor):
    """Runs once, when every branch has delivered."""

    def __init__(self, id: str, agent: Agent):
        super().__init__(id=id)
        self.agent = agent

    @handler
    async def join(self, findings: list[Finding], ctx: WorkflowContext[Never, str]) -> None:
        notes = "\n".join(f"{f.reviewer}: {f.text}" for f in findings)
        await ctx.yield_output((await self.agent.run(notes)).text)


def build(lab: Lab):
    start = Start(id="start")
    branches = [
        RuleCheck(id="rule_check"),
        Reviewer("tone", lab.agent("tone", "Is this customer reply warm and clear? One sentence.")),
        Reviewer("legal", lab.agent("legal", "Does this reply promise anything a shop could be held to? One sentence.")),
    ]
    join = Join("join", lab.agent("lead", "From these review notes, say send or rewrite, and the one change that matters most. "
                                          "Under 40 words."))
    return (WorkflowBuilder(start_executor=start, name="reply_review")
            .add_fan_out_edges(start, branches)
            .add_fan_in_edges(branches, join)
            .build())


if __name__ == "__main__":
    main(__file__)
