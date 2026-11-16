"""Task 2 with Agno: Python functions as tools; the agent runs the tool loop."""
from _agno import model
from agno.agent import Agent

from shared import checks, engagements, tasks

# tools=[...] takes plain functions: the schema comes from the signature and docstring.
agent = Agent(model=model(), instructions=tasks.SYSTEM, tools=engagements.READ_TOOLS)
answer = agent.run(tasks.QUESTION).content
print(answer)
checks.answer_ok("02_tools", answer)
