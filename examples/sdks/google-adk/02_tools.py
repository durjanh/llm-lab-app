"""Task 2 with Google ADK: Python functions as tools; the runner runs the tool loop."""
import asyncio

from _adk import ask, final_text, model
from google.adk.agents import LlmAgent

from shared import checks, engagements, tasks


async def main() -> None:
    # tools=[...] takes plain functions: the schema comes from the signature and docstring.
    agent = LlmAgent(name="analyst", model=model(), instruction=tasks.SYSTEM, tools=engagements.READ_TOOLS)
    answer = ""
    async for event in ask(agent, tasks.QUESTION):
        answer = final_text(event) or answer
    print(answer)
    checks.answer_ok("02_tools", answer)


asyncio.run(main())
