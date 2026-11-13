"""Task 2 with Strands Agents: Python functions as tools; the agent runs the tool loop."""
from _strands import as_tools, model
from strands import Agent

from shared import checks, engagements, tasks

agent = Agent(model=model(), system_prompt=tasks.SYSTEM, tools=as_tools(engagements.READ_TOOLS), callback_handler=None)
answer = str(agent(tasks.QUESTION))  # calls the model, runs each tool it asks for, repeats until it answers
print(answer)
checks.answer_ok("02_tools", answer)
