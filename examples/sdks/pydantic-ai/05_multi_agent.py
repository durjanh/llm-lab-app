"""Task 5 with PydanticAI: agent delegation. The writer agent calls the researcher agent as a tool.

PydanticAI has no crew or group-chat object: multi-agent means one agent's tool runs another agent
(passing usage=ctx.usage so the token counts add up), or plain Python calling agents in order, or a
pydantic-graph state machine for bigger flows.
"""
from _pai import model
from pydantic_ai import Agent, RunContext

from shared import checks, engagements, tasks

researcher = Agent(model(), instructions=tasks.RESEARCHER, tools=engagements.READ_TOOLS)
writer = Agent(model(), instructions=tasks.WRITER + " Call the research tool first to get the facts, including the client name.")


@writer.tool
async def research(ctx: RunContext, request: str) -> str:
    """Ask the researcher agent to gather facts from the engagement tools.

    Args:
        request: What to find out, including the engagement id.
    """
    print(f"  writer -> researcher: {request}")
    return (await researcher.run(request, usage=ctx.usage)).output


update = writer.run_sync(tasks.UPDATE_BRIEF).output
print(update)
checks.update_ok(update)
