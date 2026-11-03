"""Task 3 with the plain OpenAI SDK: the same question, the tools listed and called through an MCP client.

The OpenAI SDK has no MCP client of its own (its hosted MCP tool needs a public URL), so this uses the
official `mcp` package: list the server's tools, pass their schemas to the model, forward each call.
"""
import asyncio
import json

from _common import client
from mcp import Client, StdioServerParameters
from shared import checks, config, tasks


async def main() -> str:
    server = StdioServerParameters(command=config.MCP_COMMAND[0], args=config.MCP_COMMAND[1:])
    async with Client(server) as mcp:
        listed = (await mcp.list_tools()).tools
        tools = [{"type": "function", "function": {"name": t.name, "description": t.description or "", "parameters": t.input_schema}}
                 for t in listed if t.name != "log_risk"]  # read-only for this task
        messages = [{"role": "system", "content": tasks.SYSTEM}, {"role": "user", "content": tasks.QUESTION}]
        openai = client()
        while True:
            message = openai.chat.completions.create(model=config.AZURE_DEPLOYMENT, messages=messages, tools=tools).choices[0].message
            messages.append(message)
            if not message.tool_calls:
                return message.content or ""
            for tc in message.tool_calls:
                result = await mcp.call_tool(tc.function.name, json.loads(tc.function.arguments or "{}"))
                print(f"  mcp tool: {tc.function.name}({tc.function.arguments})")
                content = result.structured_content if result.structured_content is not None else [c.model_dump() for c in result.content]
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(content)})


answer = asyncio.run(main())
print(answer)
checks.answer_ok("03_mcp", answer)
