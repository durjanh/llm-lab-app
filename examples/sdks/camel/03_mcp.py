"""Task 3 with CAMEL: the same tools, served by an MCP server over stdio (MCPToolkit)."""
from _camel import model
from camel.agents import ChatAgent
from camel.toolkits import MCPToolkit

from shared import checks, config, tasks

servers = {"mcpServers": {"engagements": {"command": config.MCP_COMMAND[0], "args": config.MCP_COMMAND[1:]}}}
with MCPToolkit(config_dict=servers) as toolkit:  # starts the server and keeps the session open
    tools = [t for t in toolkit.get_tools() if t.get_function_name() != "log_risk"]
    print("MCP tools:", [t.get_function_name() for t in tools])
    agent = ChatAgent(system_message=tasks.SYSTEM, model=model(), tools=tools)
    answer = agent.step(tasks.QUESTION).msgs[0].content
print(answer)
checks.answer_ok("03_mcp", answer)
