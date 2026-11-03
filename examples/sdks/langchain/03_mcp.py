"""Task 3, LangChain: the same question, with the tools from the MCP server. langchain-mcp-adapters starts the
server over stdio and turns each MCP tool into a LangChain tool; the agent is unchanged."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from azure_model import llm  # noqa: E402
from langchain.agents import create_agent  # noqa: E402
from langchain_mcp_adapters.client import MultiServerMCPClient  # noqa: E402
from shared import checks, config, tasks  # noqa: E402


async def main() -> None:
    client = MultiServerMCPClient({"engagements": {"transport": "stdio", "command": config.MCP_COMMAND[0],
                                                   "args": config.MCP_COMMAND[1:]}})
    tools = [t for t in await client.get_tools() if t.name != "log_risk"]  # read-only for this task
    print("MCP tools:", [t.name for t in tools])
    agent = create_agent(llm(), tools, system_prompt=tasks.SYSTEM)
    result = await agent.ainvoke({"messages": [{"role": "user", "content": tasks.QUESTION}]})
    answer = result["messages"][-1].content
    print(answer)
    checks.answer_ok("03_mcp", answer)


asyncio.run(main())
