"""Task 1 with the OpenAI Agents SDK: an agent whose output_type is a pydantic model."""
from _common import model
from agents import Agent, Runner
from shared import checks, tasks

triage_agent = Agent(name="triage", instructions="Triage housing complaints.", model=model(), output_type=tasks.Triage)
result = Runner.run_sync(triage_agent, tasks.TRIAGE_PROMPT)
print(result.final_output)
checks.triage_ok(result.final_output)
