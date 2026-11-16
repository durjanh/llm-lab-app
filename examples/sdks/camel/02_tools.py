"""Task 2 with CAMEL: Python functions as tools; the ChatAgent runs the tool loop inside step()."""
from _camel import as_tools, model
from camel.agents import ChatAgent

from shared import checks, engagements, tasks

agent = ChatAgent(system_message=tasks.SYSTEM, model=model(), tools=as_tools(engagements.READ_TOOLS))
answer = agent.step(tasks.QUESTION).msgs[0].content
print(answer)
checks.answer_ok("02_tools", answer)
