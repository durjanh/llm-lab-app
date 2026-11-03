"""Task 1 with the Claude API: one call, a typed answer (structured outputs via messages.parse)."""
from _claude import EFFORT, FALLBACKS, MODEL, client, refused

from shared import checks, tasks

message = client().beta.messages.parse(
    model=MODEL, max_tokens=16000, system=tasks.SYSTEM, output_config=EFFORT, **FALLBACKS,
    messages=[{"role": "user", "content": tasks.TRIAGE_PROMPT}],
    output_format=tasks.Triage,  # the SDK turns the pydantic model into a JSON schema and validates the reply
)
if not refused(message):
    triage = message.parsed_output
    print(triage.model_dump_json(indent=2))
    checks.triage_ok(triage)
