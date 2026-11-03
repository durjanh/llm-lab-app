"""Task 3: the same question, with the tools coming from the MCP server over stdio.
CrewAI starts the server, lists its tools and adds them to the agent: the agent's `mcps` option."""
from crew_common import azure_llm
from crewai import Agent, Crew, Task
from crewai.mcp import MCPServerStdio, create_static_tool_filter

from shared import checks, config, tasks

server = MCPServerStdio(command=config.MCP_COMMAND[0], args=config.MCP_COMMAND[1:],
                        # read tools only: this question needs no writes
                        tool_filter=create_static_tool_filter(allowed_tool_names=["search_engagements", "get_engagement"]))

analyst = Agent(role="Delivery analyst", goal="Answer questions about engagements from the data",
                backstory=tasks.SYSTEM, llm=azure_llm(), mcps=[server], max_iter=8)
answer = Task(description=tasks.QUESTION, expected_output="The engagements, their high risks and budget used, in a few sentences",
              agent=analyst)
result = Crew(agents=[analyst], tasks=[answer]).kickoff()

print(result.raw)
checks.answer_ok("03_mcp", result.raw)
