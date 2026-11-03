"""Task 3 with the OpenAI Agents SDK: the tools come from the MCP server, attached with mcp_servers=[...]."""
import asyncio

from _common import model
from agents import Agent, Runner
from agents.mcp import MCPServerStdio
from shared import checks, config, tasks


async def main() -> str:
    async with MCPServerStdio(name="engagements", params={"command": config.MCP_COMMAND[0], "args": config.MCP_COMMAND[1:]},
                              cache_tools_list=True) as server:
        agent = Agent(name="assistant", instructions=tasks.SYSTEM, model=model(), mcp_servers=[server])
        result = await Runner.run(agent, tasks.QUESTION)
        for item in result.new_items:
            if item.type == "tool_call_item":
                print(f"  mcp tool: {getattr(item.raw_item, 'name', '?')}({getattr(item.raw_item, 'arguments', '')})")
        return result.final_output


answer = asyncio.run(main())
print(answer)
checks.answer_ok("03_mcp", answer)
