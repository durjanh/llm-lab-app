"""Task 5 in AutoGen: a RoundRobinGroupChat team. The researcher (with tools) speaks first, then the writer;
MaxMessageTermination stops the team after the task message and one turn each."""
import asyncio

from ag_common import azure_client
from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.conditions import MaxMessageTermination
from autogen_agentchat.teams import RoundRobinGroupChat
from shared import checks, engagements, tasks


async def main() -> None:
    client = azure_client()
    researcher = AssistantAgent("researcher", model_client=client, system_message=tasks.RESEARCHER,
                                tools=engagements.READ_TOOLS, max_tool_iterations=5, reflect_on_tool_use=True)
    writer = AssistantAgent("writer", model_client=client, system_message=tasks.WRITER)
    team = RoundRobinGroupChat([researcher, writer], termination_condition=MaxMessageTermination(3))
    result = await team.run(task=tasks.UPDATE_BRIEF)
    for m in result.messages:
        print(f"  [{m.source}] {str(m.content)[:120]}…")
    update = str(result.messages[-1].content)
    print(f"\n{update}")
    checks.update_ok(update)
    await client.close()


asyncio.run(main())
