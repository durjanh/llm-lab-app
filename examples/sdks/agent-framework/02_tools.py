"""Task 2 with Agent Framework: Python functions as tools (@tool); the chat client runs the function-calling loop."""
import asyncio

from _af import chat_client, trace
from agent_framework import Agent, tool

from shared import checks, engagements, tasks


async def main() -> None:
    agent = Agent(chat_client(), tasks.SYSTEM, name="analyst",
                  tools=[tool(f) for f in engagements.READ_TOOLS],  # schema from the signature and type hints
                  middleware=[trace])
    response = await agent.run(tasks.QUESTION)
    print(response.text)
    checks.answer_ok("02_tools", response.text)


asyncio.run(main())
