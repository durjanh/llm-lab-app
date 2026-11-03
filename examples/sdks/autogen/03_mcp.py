"""Task 3 in AutoGen: the same question with the tools from the MCP server, through an McpWorkbench (stdio)."""
import asyncio

from ag_common import azure_client
from autogen_agentchat.agents import AssistantAgent
from autogen_ext.tools.mcp import McpWorkbench, StdioServerParams
from shared import checks, config, tasks


async def main() -> None:
    client = azure_client()
    server = StdioServerParams(command=config.MCP_COMMAND[0], args=config.MCP_COMMAND[1:], read_timeout_seconds=30)
    async with McpWorkbench(server) as workbench:  # starts the server and lists its tools for the agent
        agent = AssistantAgent("analyst", model_client=client, system_message=tasks.SYSTEM, workbench=workbench,
                               max_tool_iterations=5, reflect_on_tool_use=True)
        result = await agent.run(task=tasks.QUESTION)
    answer = str(result.messages[-1].content)
    print(answer)
    checks.answer_ok("03_mcp", answer)
    await client.close()


asyncio.run(main())
