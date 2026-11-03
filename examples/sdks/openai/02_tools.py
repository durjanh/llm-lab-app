"""Task 2 with the plain OpenAI SDK: function tools, and the tool loop written by hand."""
import json

from _common import call, client, tool_schema
from shared import checks, config, engagements, tasks

fns = {f.__name__: f for f in engagements.READ_TOOLS}
tools = [tool_schema(f) for f in engagements.READ_TOOLS]
messages = [{"role": "system", "content": tasks.SYSTEM}, {"role": "user", "content": tasks.QUESTION}]
openai = client()

while True:  # until the model answers instead of calling a tool
    message = openai.chat.completions.create(model=config.AZURE_DEPLOYMENT, messages=messages, tools=tools).choices[0].message
    messages.append(message)
    if not message.tool_calls:
        break
    for tc in message.tool_calls:  # run every call the model asked for, and send each result back
        result = call(fns, tc.function.name, tc.function.arguments)
        print(f"  tool: {tc.function.name}({tc.function.arguments})")
        messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(result)})

print(message.content)
checks.answer_ok("02_tools", message.content or "")
