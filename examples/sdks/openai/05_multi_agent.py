"""Task 5 with the plain OpenAI SDK: two "agents" are just two prompts, chained by your own code.

A researcher with the tools gathers facts; a writer with no tools turns them into the update.
There is no multi-agent construct in the plain SDK: the hand-off is a variable.
"""
import json

from _common import call, client, tool_schema
from shared import checks, config, engagements, tasks

openai = client()


def researcher(brief: str) -> str:
    fns = {f.__name__: f for f in engagements.READ_TOOLS}
    tools = [tool_schema(f) for f in engagements.READ_TOOLS]
    messages = [{"role": "system", "content": tasks.RESEARCHER}, {"role": "user", "content": brief}]
    for _ in range(8):
        message = openai.chat.completions.create(model=config.AZURE_DEPLOYMENT, messages=messages, tools=tools).choices[0].message
        messages.append(message)
        if not message.tool_calls:
            return message.content or ""
        for tc in message.tool_calls:
            print(f"  researcher tool: {tc.function.name}({tc.function.arguments})")
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(call(fns, tc.function.name, tc.function.arguments))})
    return message.content or ""


def writer(facts: str) -> str:
    return openai.chat.completions.create(model=config.AZURE_DEPLOYMENT, messages=[
        {"role": "system", "content": tasks.WRITER},
        {"role": "user", "content": f"{tasks.UPDATE_BRIEF}\n\nThe researcher's facts:\n{facts}"}]).choices[0].message.content or ""


facts = researcher(tasks.UPDATE_BRIEF)
print("Researcher:\n" + facts + "\n")
update = writer(facts)
print("Writer:\n" + update)
checks.update_ok(update)
