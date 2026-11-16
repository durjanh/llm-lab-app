"""Task 1 with Google ADK: one call, a typed answer (LlmAgent(output_schema=Model) -> JSON in the final reply)."""
import asyncio

from _adk import ask, final_text, model
from google.adk.agents import LlmAgent

from shared import checks, tasks


async def main() -> None:
    agent = LlmAgent(name="triage", model=model(), instruction=tasks.SYSTEM, output_schema=tasks.Triage)
    reply = ""
    async for event in ask(agent, tasks.TRIAGE_PROMPT):
        reply = final_text(event) or reply
    triage = tasks.Triage.model_validate_json(reply)  # ADK asks for JSON matching the schema; validate it here
    print(triage.model_dump_json(indent=2))
    checks.triage_ok(triage)


asyncio.run(main())
