"""Task 1 with Strands Agents: one call, a typed answer (structured_output_model)."""
from _strands import model
from strands import Agent

from shared import checks, tasks

agent = Agent(model=model(), system_prompt=tasks.SYSTEM, callback_handler=None)
result = agent(tasks.TRIAGE_PROMPT, structured_output_model=tasks.Triage)  # Strands makes the pydantic model a forced tool
triage = result.structured_output
print(triage.model_dump_json(indent=2))
checks.triage_ok(triage)
