"""Task 5 with LlamaIndex Workflows: events and steps. A research step emits a FactsEvent, a write step handles it.

A Workflow is an event-driven state machine: each @step takes one event type and returns the next, and the
type annotations are the wiring. LlamaIndex also has AgentWorkflow, which hands off between agents for you;
a Workflow shows the mechanism, and each step can call an agent (here a FunctionAgent) or any code.
"""
import asyncio

from _li import llm
from llama_index.core.agent.workflow import FunctionAgent
from llama_index.core.workflow import Event, StartEvent, StopEvent, Workflow, step

from shared import checks, engagements, tasks


class FactsEvent(Event):
    facts: str


class UpdateDesk(Workflow):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.researcher = FunctionAgent(tools=engagements.READ_TOOLS, llm=llm(),
                                        system_prompt=tasks.RESEARCHER + " Always report the client name.")
        self.writer = FunctionAgent(tools=[], llm=llm(), system_prompt=tasks.WRITER)

    @step
    async def research(self, ev: StartEvent) -> FactsEvent:  # runs first: StartEvent carries run(brief=...)
        return FactsEvent(facts=str(await self.researcher.run(ev.brief)))

    @step
    async def write(self, ev: FactsEvent) -> StopEvent:  # runs when a FactsEvent is emitted
        return StopEvent(result=str(await self.writer.run(f"Brief: {tasks.UPDATE_BRIEF}\n\nResearcher's facts:\n{ev.facts}")))


async def main() -> None:
    update = await UpdateDesk(timeout=120).run(brief=tasks.UPDATE_BRIEF)
    print(update)
    checks.update_ok(update)


asyncio.run(main())
