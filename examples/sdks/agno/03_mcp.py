"""Task 3 with Agno: the same tools, served by an MCP server over stdio (MCPTools)."""
import asyncio

from _agno import model
from agno.agent import Agent
from agno.tools.mcp import MCPTools

from shared import checks, config, tasks


async def main() -> None:
    command = " ".join(config.MCP_COMMAND)
    async with MCPTools(command=command, exclude_tools=["log_risk"], timeout_seconds=30) as mcp:  # starts the server
        print("MCP tools:", list(mcp.functions))
        agent = Agent(model=model(), instructions=tasks.SYSTEM, tools=[mcp])
        answer = (await agent.arun(tasks.QUESTION)).content
    print(answer)
    checks.answer_ok("03_mcp", answer)


asyncio.run(main())
