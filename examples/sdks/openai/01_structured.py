"""Task 1 with the plain OpenAI SDK: one call, the answer parsed into a pydantic model."""
from _common import client
from shared import checks, config, tasks

completion = client().chat.completions.parse(
    model=config.AZURE_DEPLOYMENT,
    messages=[{"role": "user", "content": tasks.TRIAGE_PROMPT}],
    response_format=tasks.Triage,  # the SDK turns the model into a strict JSON schema and parses the reply
)
triage = completion.choices[0].message.parsed
print(triage)
checks.triage_ok(triage)
