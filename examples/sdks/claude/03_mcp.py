"""Task 3 with the Claude API: the same tools, served by an MCP server over stdio.

The SDK's MCP helpers (anthropic.lib.tools.mcp) turn each MCP tool into a tool the runner can call.
For a hosted server reachable over HTTPS, the Messages API's MCP connector (mcp_servers + mcp_toolset)
lets Anthropic's servers call it instead; see examples/mcp/remote_connector.py.
"""
import asyncio

from _claude import EFFORT, FALLBACKS, MODEL, async_client, refused, text_of
from anthropic.lib.tools.mcp import async_mcp_tool
from mcp import Client, StdioServerParameters

from shared import checks, config, tasks


async def main() -> None:
    server = StdioServerParameters(command=config.MCP_COMMAND[0], args=config.MCP_COMMAND[1:])
    async with Client(server) as mcp:
        listed = (await mcp.list_tools()).tools
        print("MCP tools:", [t.name for t in listed])
        read_only = [t for t in listed if t.annotations and t.annotations.read_only_hint]  # leave log_risk out
        runner = async_client().beta.messages.tool_runner(
            model=MODEL, max_tokens=16000, system=tasks.SYSTEM, output_config=EFFORT, **FALLBACKS,
            tools=[async_mcp_tool(t, mcp) for t in read_only],
            messages=[{"role": "user", "content": tasks.QUESTION}],
            max_iterations=8,
        )
        final = await runner.until_done()
    if not refused(final):
        answer = text_of(final)
        print(answer)
        checks.answer_ok("03_mcp", answer)


asyncio.run(main())
