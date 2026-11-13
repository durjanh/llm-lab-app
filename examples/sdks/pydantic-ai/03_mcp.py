"""Task 3 with PydanticAI: the same tools, served by an MCP server over stdio (MCPToolset)."""
import asyncio

from _pai import model
from fastmcp.client.transports import StdioTransport
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPToolset

from shared import checks, config, tasks


async def main() -> None:
    toolset = MCPToolset(StdioTransport(command=config.MCP_COMMAND[0], args=config.MCP_COMMAND[1:]))
    toolset = toolset.filtered(lambda ctx, tool: tool.name != "log_risk")  # leave the write tool out
    agent = Agent(model(), instructions=tasks.SYSTEM, toolsets=[toolset])
    async with agent:  # starts the MCP server for the run
        result = await agent.run(tasks.QUESTION)
    print(result.output)
    checks.answer_ok("03_mcp", result.output)


asyncio.run(main())
