"""Task 1 with Agno: one call, a typed answer (Agent(output_schema=Model) -> response.content)."""
from _agno import model
from agno.agent import Agent

from shared import checks, tasks

agent = Agent(model=model(), instructions=tasks.SYSTEM, output_schema=tasks.Triage)
triage = agent.run(tasks.TRIAGE_PROMPT).content  # an instance of the pydantic model
print(triage.model_dump_json(indent=2))
checks.triage_ok(triage)
