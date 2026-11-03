"""Task 1 in AutoGen: an AssistantAgent with output_content_type returns a StructuredMessage of the pydantic model."""
import asyncio

from ag_common import azure_client
from autogen_agentchat.agents import AssistantAgent
from shared import checks, tasks


async def main() -> None:
    client = azure_client()
    agent = AssistantAgent("triage", model_client=client, system_message="You triage housing complaints.",
                           output_content_type=tasks.Triage)
    result = await agent.run(task=tasks.TRIAGE_PROMPT)
    triage = result.messages[-1].content  # StructuredMessage[Triage]: content is the Triage object
    print(triage)
    checks.triage_ok(triage)
    await client.close()


asyncio.run(main())
