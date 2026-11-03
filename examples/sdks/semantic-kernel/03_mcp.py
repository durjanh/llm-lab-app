"""Task 3 in Semantic Kernel: the same question, with the tools loaded from the MCP server over stdio (MCPStdioPlugin)."""
import asyncio

from sk_common import azure_service
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.mcp import MCPStdioPlugin
from shared import checks, config, tasks


async def main() -> None:
    # The plugin starts the server as a subprocess and turns each MCP tool into a kernel function.
    async with MCPStdioPlugin(name="engagements", description="The engagement tracker",
                              command=config.MCP_COMMAND[0], args=config.MCP_COMMAND[1:]) as mcp:
        agent = ChatCompletionAgent(service=azure_service(), name="analyst", instructions=tasks.SYSTEM, plugins=[mcp])
        response = await agent.get_response(messages=tasks.QUESTION)
    print(response.content)
    checks.answer_ok("03_mcp", str(response.content))


asyncio.run(main())
