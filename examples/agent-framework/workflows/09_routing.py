"""Deterministic routing: switch-case and multi-selection edges.

A model reads the message into a typed ticket, and from there plain code decides the route. Switch-case sends a message
to exactly one target. Multi-selection sends it to whichever targets the message needs. When the route can be worked out
from the input, this is cheaper and easier to test than letting agents hand off to each other.

    python 09_routing.py
"""
from __future__ import annotations

from typing import Literal

from agent_framework import Agent, Case, Default, Executor, WorkflowBuilder, WorkflowContext, handler
from pydantic import BaseModel
from typing_extensions import Never

from _wf import Lab, main

TITLE = "Routing: switch-case and multi-selection"
TASK = "Order PC-2210 came a week late and the invoice shows the wrong price. Not urgent, but please sort it out."


class Ticket(BaseModel):
    urgent: bool
    teams: list[Literal["billing", "shipping", "product"]]
    summary: str


class Intake(Executor):
    def __init__(self, agent: Agent):
        super().__init__(id="intake")
        self.agent = agent

    @handler
    async def read(self, message: str, ctx: WorkflowContext[Ticket]) -> None:
        await ctx.send_message((await self.agent.run(message, options={"response_format": Ticket})).value)


class UrgentDesk(Executor):
    @handler
    async def page(self, ticket: Ticket, ctx: WorkflowContext[Never, str]) -> None:
        await ctx.yield_output(f"Sent to the on-call person, without a model reply: {ticket.summary}")


class Sorter(Executor):
    @handler
    async def sort(self, ticket: Ticket, ctx: WorkflowContext[Ticket]) -> None:
        await ctx.send_message(ticket)


class Team(Executor):
    def __init__(self, id: str, agent: Agent):
        super().__init__(id=id)
        self.agent = agent

    @handler
    async def act(self, ticket: Ticket, ctx: WorkflowContext[Never, str]) -> None:
        await ctx.yield_output(f"{self.id}: {(await self.agent.run(ticket.summary)).text}")


def build(lab: Lab):
    intake = Intake(lab.agent("intake", "Read the customer's message into a ticket. Urgent means a safety problem only."))
    urgent, sorter = UrgentDesk(id="urgent_desk"), Sorter(id="sorter")
    teams = [Team(t, lab.agent(t, f"You are the {t} team. Say in under 25 words what you will do about your part only."))
             for t in ("billing", "shipping", "product")]
    return (WorkflowBuilder(start_executor=intake, name="ticket_routing")
            .add_switch_case_edge_group(intake, [Case(condition=lambda t: t.urgent, target=urgent), Default(target=sorter)])
            .add_multi_selection_edge_group(sorter, teams, selection_func=lambda t, ids: [i for i in ids if i in t.teams])
            .build())


if __name__ == "__main__":
    main(__file__)
