"""Task 1 with CAMEL: one call, a typed answer (agent.step(prompt, response_format=Model) -> msg.parsed)."""
from _camel import model
from camel.agents import ChatAgent

from shared import checks, tasks

agent = ChatAgent(system_message=tasks.SYSTEM, model=model())
triage = agent.step(tasks.TRIAGE_PROMPT, response_format=tasks.Triage).msgs[0].parsed  # a pydantic instance
print(triage.model_dump_json(indent=2))
checks.triage_ok(triage)
