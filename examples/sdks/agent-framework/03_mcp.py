"""Task 3 with Agent Framework: the tools come from the MCP server over stdio (MCPStdioTool)."""
import asyncio

from _af import chat_client, trace
from agent_framework import Agent, MCPStdioTool

from shared import checks, config, tasks


async def main() -> None:
    mcp = MCPStdioTool(name="engagements", command=config.MCP_COMMAND[0], args=config.MCP_COMMAND[1:],
                       allowed_tools=["search_engagements", "get_engagement"])  # leave the write tool out
    async with mcp:  # starts the server process and lists its tools
        print("MCP tools:", [f.name for f in mcp.functions])
        agent = Agent(chat_client(), tasks.SYSTEM, name="analyst", tools=[mcp], middleware=[trace])
        response = await agent.run(tasks.QUESTION)
    print(response.text)
    checks.answer_ok("03_mcp", response.text)


asyncio.run(main())
