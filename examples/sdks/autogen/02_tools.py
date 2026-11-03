"""Task 2 in AutoGen: plain Python functions as tools (AutoGen wraps them in FunctionTool); the agent runs the
loop for up to max_tool_iterations rounds, then answers."""
import asyncio

from ag_common import azure_client
from autogen_agentchat.agents import AssistantAgent
from shared import checks, engagements, tasks


async def main() -> None:
    client = azure_client()
    agent = AssistantAgent("analyst", model_client=client, system_message=tasks.SYSTEM, tools=engagements.READ_TOOLS,
                           max_tool_iterations=5, reflect_on_tool_use=True)
    result = await agent.run(task=tasks.QUESTION)
    answer = str(result.messages[-1].content)
    print(answer)
    checks.answer_ok("02_tools", answer)
    await client.close()


asyncio.run(main())
