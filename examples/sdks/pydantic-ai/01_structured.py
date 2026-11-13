"""Task 1 with PydanticAI: one call, a typed answer (Agent(output_type=Model) -> result.output)."""
from _pai import model
from pydantic_ai import Agent

from shared import checks, tasks

agent = Agent(model(), output_type=tasks.Triage, instructions=tasks.SYSTEM)
result = agent.run_sync(tasks.TRIAGE_PROMPT)  # the reply is validated against the model; a bad one is retried
print(result.output.model_dump_json(indent=2))
checks.triage_ok(result.output)
