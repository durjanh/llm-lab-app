"""Task 3 with Google ADK: the same tools, served by an MCP server over stdio (McpToolset)."""
import asyncio

from _adk import ask, final_text, model
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import McpToolset, StdioConnectionParams
from mcp import StdioServerParameters

from shared import checks, config, tasks


async def main() -> None:
    server = StdioServerParameters(command=config.MCP_COMMAND[0], args=config.MCP_COMMAND[1:])
    toolset = McpToolset(connection_params=StdioConnectionParams(server_params=server, timeout=30),
                         tool_filter=["search_engagements", "get_engagement"])  # leave the write tool out
    agent = LlmAgent(name="analyst", model=model(), instruction=tasks.SYSTEM, tools=[toolset])
    answer = ""
    try:
        async for event in ask(agent, tasks.QUESTION):
            answer = final_text(event) or answer
    finally:
        await toolset.close()  # stops the server
    print(answer)
    checks.answer_ok("03_mcp", answer)


asyncio.run(main())
