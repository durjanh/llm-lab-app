"""Task 3 with LlamaIndex: the same tools, served by an MCP server over stdio (BasicMCPClient + McpToolSpec)."""
import asyncio

from _li import llm
from llama_index.core.agent.workflow import FunctionAgent
from llama_index.tools.mcp import BasicMCPClient, McpToolSpec

from shared import checks, config, tasks


async def main() -> None:
    client = BasicMCPClient(config.MCP_COMMAND[0], args=config.MCP_COMMAND[1:])  # starts the server for each call
    spec = McpToolSpec(client=client, allowed_tools=["search_engagements", "get_engagement"])  # leave the write tool out
    tools = await spec.to_tool_list_async()
    print("MCP tools:", [t.metadata.name for t in tools])
    agent = FunctionAgent(tools=tools, llm=llm(), system_prompt=tasks.SYSTEM)
    answer = str(await agent.run(tasks.QUESTION))
    print(answer)
    checks.answer_ok("03_mcp", answer)


asyncio.run(main())
