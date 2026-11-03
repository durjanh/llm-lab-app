"""Task 3, LangGraph: the same graph, with the tools loaded from the MCP server by langchain-mcp-adapters."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from azure_model import llm  # noqa: E402
from graph_parts import agent_graph  # noqa: E402
from langchain_mcp_adapters.client import MultiServerMCPClient  # noqa: E402
from shared import checks, config, tasks  # noqa: E402


async def main() -> None:
    client = MultiServerMCPClient({"engagements": {"transport": "stdio", "command": config.MCP_COMMAND[0],
                                                   "args": config.MCP_COMMAND[1:]}})
    tools = [t for t in await client.get_tools() if t.name != "log_risk"]
    print("MCP tools:", [t.name for t in tools])
    graph = agent_graph(llm(), tools, tasks.SYSTEM)
    result = await graph.ainvoke({"messages": [("user", tasks.QUESTION)]}, {"recursion_limit": 12})
    answer = result["messages"][-1].content
    print(answer)
    checks.answer_ok("03_mcp", answer)


asyncio.run(main())
