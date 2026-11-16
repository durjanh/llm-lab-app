"""Task 3 with Bedrock: the same tools, served by an MCP server over stdio. Bedrock has no MCP client for local
servers, so the `mcp` package lists the tools, they become Converse toolSpecs, and tool calls go back to the server."""
import asyncio

import _bedrock as b
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from shared import checks, config, tasks


async def main() -> None:
    server = StdioServerParameters(command=config.MCP_COMMAND[0], args=config.MCP_COMMAND[1:])
    async with stdio_client(server) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        found = [t for t in (await session.list_tools()).tools if t.name != "log_risk"]  # leave the write tool out
        specs = [{"toolSpec": {"name": t.name, "description": t.description or t.name, "inputSchema": {"json": t.input_schema}}}
                 for t in found]
        print("MCP tools:", [t.name for t in found])
        bedrock = b.Client("bedrock-runtime")
        messages = [{"role": "user", "content": [{"text": tasks.QUESTION}]}]
        while True:
            reply = bedrock.converse(modelId=b.MODEL_ID, system=[{"text": tasks.SYSTEM}], messages=messages,
                                     toolConfig={"tools": specs})
            message = reply["output"]["message"]
            messages.append(message)
            if reply["stopReason"] != "tool_use":
                break
            results = []
            for block in message["content"]:
                if "toolUse" in block:
                    use = block["toolUse"]
                    result = await session.call_tool(use["name"], use["input"])
                    text = "".join(c.text for c in result.content if hasattr(c, "text"))
                    results.append({"toolResult": {"toolUseId": use["toolUseId"], "content": [{"text": text}],
                                                   "status": "error" if result.is_error else "success"}})
            messages.append({"role": "user", "content": results})
    answer = "".join(block.get("text", "") for block in message["content"])
    print(answer)
    checks.answer_ok("03_mcp", answer)


b.require_aws("03_mcp")
b.run("03_mcp", lambda: asyncio.run(main()))
