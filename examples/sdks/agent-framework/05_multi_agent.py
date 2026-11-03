"""Task 5 with Agent Framework: a sequential orchestration (SequentialBuilder) of a researcher and a writer.

Each participant gets the conversation so far and adds its reply; with output_from="all" the workflow
yields every participant's response. Other orchestrations in the same package: Concurrent, GroupChat, Handoff, Magentic.
"""
import asyncio

from _af import chat_client, trace
from agent_framework import Agent, tool
from agent_framework.orchestrations import SequentialBuilder

from shared import checks, engagements, tasks


async def main() -> None:
    client = chat_client()
    researcher = Agent(client, tasks.RESEARCHER, name="researcher",
                       tools=[tool(f) for f in engagements.READ_TOOLS], middleware=[trace])
    writer = Agent(client, tasks.WRITER, name="writer")
    workflow = SequentialBuilder(participants=[researcher, writer], output_from="all").build()
    result = await workflow.run(tasks.UPDATE_BRIEF)
    replies = result.get_outputs()  # one AgentResponse per participant, in order
    for name, reply in zip(["researcher", "writer"], replies):
        print(f"\n[{name}]\n{reply.text}")
    checks.update_ok(replies[-1].text)


asyncio.run(main())
