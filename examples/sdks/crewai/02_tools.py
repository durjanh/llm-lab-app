"""Task 2: function tools. The shared Python functions become CrewAI tools with @tool; the agent's executor runs the loop."""
from crew_common import as_tool, azure_llm
from crewai import Agent, Crew, Task

from shared import checks, engagements, tasks

tools = [as_tool(f) for f in engagements.READ_TOOLS]  # name, docstring and type hints become the schema

analyst = Agent(role="Delivery analyst", goal="Answer questions about engagements from the data",
                backstory=tasks.SYSTEM, llm=azure_llm(), tools=tools, max_iter=8)
answer = Task(description=tasks.QUESTION, expected_output="The engagements, their high risks and budget used, in a few sentences",
              agent=analyst)
result = Crew(agents=[analyst], tasks=[answer]).kickoff()

print(result.raw)
checks.answer_ok("02_tools", result.raw)
