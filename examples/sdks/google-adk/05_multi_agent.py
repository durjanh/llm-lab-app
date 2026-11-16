"""Task 5 with Google ADK: a SequentialAgent, a researcher then a writer sharing session state.

The researcher's reply is saved under output_key="facts"; the writer's instruction uses {facts}, which ADK fills
from state. ADK also has ParallelAgent, LoopAgent, and an LlmAgent with sub_agents that it transfers control to.
"""
import asyncio

from _adk import ask, final_text, model
from google.adk.agents import LlmAgent, SequentialAgent

from shared import checks, engagements, tasks


async def main() -> None:
    researcher = LlmAgent(name="researcher", model=model(), instruction=tasks.RESEARCHER + " Always report the client name.",
                          tools=engagements.READ_TOOLS, output_key="facts")
    writer = LlmAgent(name="writer", model=model(), instruction=tasks.WRITER + "\n\nThe researcher's facts:\n{facts}")
    desk = SequentialAgent(name="desk", sub_agents=[researcher, writer])
    update = ""
    async for event in ask(desk, tasks.UPDATE_BRIEF):
        if event.author == "writer":
            update = final_text(event) or update
    print(update)
    checks.update_ok(update)


asyncio.run(main())
