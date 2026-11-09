"""Maker-checker loop, also called evaluator-optimizer, generator-verifier or a critic loop.

One agent writes and another judges against stated criteria, round after round. Microsoft asks for three things, all
here: clear acceptance criteria, an iteration cap, and a fallback when the cap is reached (a person takes over).

    python 06_maker_checker.py
"""
from __future__ import annotations

from dataclasses import dataclass, field

from agent_framework import Agent, Case, Default, Executor, WorkflowBuilder, WorkflowContext, handler
from pydantic import BaseModel
from typing_extensions import Never

from _wf import Lab, main

TITLE = "Maker-checker loop"
TASK = "Reply to a customer whose e-bike delivery is a week late. They want to know when it will arrive."
CAP = 3
CRITERIA = ("1. Under 45 words. 2. Apologises once. 3. Gives a specific next step with a date or a time frame. "
            "4. Does not blame the courier. 5. Ends with the exact words: Reply to this email if anything changes.")


class Verdict(BaseModel):
    approved: bool
    problems: list[str]


@dataclass
class Draft:
    brief: str
    body: str = ""
    round: int = 0
    problems: list[str] = field(default_factory=list)
    approved: bool = False

    @property
    def text(self) -> str:
        """What this step has to say: the checker's verdict once there is one, otherwise the draft."""
        if self.approved:
            return "Approved."
        return "Rejected: " + "; ".join(self.problems) if self.problems else self.body


class Maker(Executor):
    def __init__(self, agent: Agent):
        super().__init__(id="maker")
        self.agent = agent

    @handler
    async def first(self, brief: str, ctx: WorkflowContext[Draft]) -> None:
        await self._write(Draft(brief=brief), f"Task: {brief}", ctx)  # no rules yet: the checker is what enforces them

    @handler
    async def revise(self, draft: Draft, ctx: WorkflowContext[Draft]) -> None:
        await self._write(draft, f"Rules: {CRITERIA}\nYour draft: {draft.body}\nFix these problems: {draft.problems}", ctx)

    async def _write(self, draft: Draft, prompt: str, ctx: WorkflowContext[Draft]) -> None:
        draft.body, draft.round, draft.problems = (await self.agent.run(prompt)).text, draft.round + 1, []
        await ctx.send_message(draft)


class Checker(Executor):
    def __init__(self, agent: Agent):
        super().__init__(id="checker")
        self.agent = agent

    @handler
    async def check(self, draft: Draft, ctx: WorkflowContext[Draft]) -> None:
        reply = await self.agent.run(f"Rules: {CRITERIA}\nDraft: {draft.body}", options={"response_format": Verdict})
        draft.approved, draft.problems = reply.value.approved, reply.value.problems
        await ctx.send_message(draft)


class Publish(Executor):
    @handler
    async def publish(self, draft: Draft, ctx: WorkflowContext[Never, str]) -> None:
        await ctx.yield_output(f"Approved on round {draft.round}:\n{draft.body}")


class Escalate(Executor):
    @handler
    async def escalate(self, draft: Draft, ctx: WorkflowContext[Never, str]) -> None:
        await ctx.yield_output(f"Not approved after {CAP} rounds. For a person to finish.\n{draft.body}\nStill wrong: {draft.problems}")


def build(lab: Lab):
    maker = Maker(lab.agent("writer", "You write short customer replies. Return only the reply."))
    checker = Checker(lab.agent("reviewer", "Judge the draft strictly against each rule. Approve only if all are met."))
    publish, escalate = Publish(id="publish"), Escalate(id="escalate")
    return (WorkflowBuilder(start_executor=maker, name="maker_checker", max_iterations=CAP * 2 + 2)
            .add_edge(maker, checker)
            .add_switch_case_edge_group(checker, [Case(condition=lambda d: d.approved, target=publish),
                                                  Case(condition=lambda d: d.round >= CAP, target=escalate),
                                                  Default(target=maker)])
            .build())


if __name__ == "__main__":
    main(__file__)
