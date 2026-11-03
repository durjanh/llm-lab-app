"""Task 4 with the plain OpenAI SDK: an autonomous agent, where the harness is yours to write.

Everything an agent framework would give you is here by hand: the loop, a step limit, a trace of each
tool call, and a gate that asks a person before any write tool runs.
"""
import argparse
import json

from _common import call, client, tool_schema
from shared import checks, config, engagements, tasks

MAX_STEPS = 12

parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
args = parser.parse_args()

fns = {f.__name__: f for f in engagements.ALL_TOOLS}
tools = [tool_schema(f) for f in engagements.ALL_TOOLS]
messages = [{"role": "system", "content": tasks.SYSTEM}, {"role": "user", "content": tasks.GOAL}]
openai = client()

for step in range(1, MAX_STEPS + 1):
    message = openai.chat.completions.create(model=config.AZURE_DEPLOYMENT, messages=messages, tools=tools).choices[0].message
    messages.append(message)
    if not message.tool_calls:
        break
    for tc in message.tool_calls:
        print(f"  step {step}: {tc.function.name}({tc.function.arguments})")
        if tc.function.name in engagements.WRITE_TOOLS and not checks.approve(tc.function.name, json.loads(tc.function.arguments), args.auto_approve):
            result = {"error": "A person declined this action. Do not retry it."}
        else:
            result = call(fns, tc.function.name, tc.function.arguments)
        messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(result)})
else:
    print(f"Stopped: reached the {MAX_STEPS}-step limit.")

print(message.content)
checks.agent_ok()
