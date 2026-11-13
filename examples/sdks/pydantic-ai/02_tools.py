"""Task 2 with PydanticAI: Python functions as tools; the agent runs the tool loop."""
from _pai import model
from pydantic_ai import Agent

from shared import checks, engagements, tasks

# tools=[...] takes plain functions: the schema comes from the signature and docstring.
agent = Agent(model(), instructions=tasks.SYSTEM, tools=engagements.READ_TOOLS)
answer = agent.run_sync(tasks.QUESTION).output
print(answer)
checks.answer_ok("02_tools", answer)
