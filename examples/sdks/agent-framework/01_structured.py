"""Task 1 with Microsoft Agent Framework: an Agent whose answer is a typed object (response_format)."""
import asyncio

from _af import chat_client
from agent_framework import Agent

from shared import checks, tasks


async def main() -> None:
    agent = Agent(chat_client(), tasks.SYSTEM, name="triage")
    response = await agent.run(tasks.TRIAGE_PROMPT, options={"response_format": tasks.Triage})
    triage = response.value  # parsed and validated into the pydantic model
    print(triage.model_dump_json(indent=2))
    checks.triage_ok(triage)


asyncio.run(main())
