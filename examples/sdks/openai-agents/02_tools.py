"""Task 2 with the OpenAI Agents SDK: function tools; the Runner runs the tool loop."""
from _common import Trace, get_engagement, model, search_engagements
from agents import Agent, Runner
from shared import checks, tasks

agent = Agent(name="assistant", instructions=tasks.SYSTEM, model=model(), tools=[search_engagements, get_engagement])
result = Runner.run_sync(agent, tasks.QUESTION, hooks=Trace())
print(result.final_output)
checks.answer_ok("02_tools", result.final_output)
