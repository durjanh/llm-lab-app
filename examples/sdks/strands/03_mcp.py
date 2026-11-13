"""Task 3 with Strands Agents: the same tools, served by an MCP server over stdio (strands.tools.mcp.MCPClient)."""
from _strands import model
from mcp import StdioServerParameters
from mcp.client.stdio import stdio_client
from strands import Agent
from strands.tools.mcp import MCPClient

from shared import checks, config, tasks

server = StdioServerParameters(command=config.MCP_COMMAND[0], args=config.MCP_COMMAND[1:])
mcp = MCPClient(lambda: stdio_client(server))
with mcp:  # starts the server and keeps the session open while the agent runs
    tools = [t for t in mcp.list_tools_sync() if t.tool_name != "log_risk"]
    print("MCP tools:", [t.tool_name for t in tools])
    agent = Agent(model=model(), system_prompt=tasks.SYSTEM, tools=tools, callback_handler=None)
    answer = str(agent(tasks.QUESTION))
print(answer)
checks.answer_ok("03_mcp", answer)
