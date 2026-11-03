"""Claude uses the engagements MCP server through the Claude API: the harness side of MCP.

Starts server.py over stdio, lists its tools, and hands them to the SDK's tool runner, which
loops until Claude has finished. The harness, not the model, decides what needs a person:
any tool the server does not mark read-only waits for approval before it runs.

    python ask_claude.py
    python ask_claude.py --task "Log a high risk on the Brightwater engagement: the client's legal team is on leave until December. Priya owns it."
    python ask_claude.py --auto-approve --model claude-haiku-5-5
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic
from anthropic.lib.tools.mcp import async_mcp_tool
from mcp import Client, StdioServerParameters
from mcp.types import CallToolResult, TextContent

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
from common import describe_usage, fallback_params  # noqa: E402

SERVER = StdioServerParameters(command=sys.executable, args=[str(Path(__file__).with_name("server.py"))])


class Approvals:
    """Passes tool calls to the MCP client, asking a person first for any tool that can change data.
    The model cannot skip this: it only ever sees the result."""

    def __init__(self, client: Client, read_only: set[str], auto_approve: bool):
        self.client, self.read_only, self.auto_approve = client, read_only, auto_approve

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None, **kwargs: Any):
        if name not in self.read_only:
            print(f"\n  Approval needed: {name}({json.dumps(arguments)})")
            if not self.auto_approve and input("  Allow it? [y/N] ").strip().lower() != "y":
                return CallToolResult(is_error=True, content=[TextContent(
                    type="text", text="A person declined this call. Do not retry it; tell the user it was not done.")])
        return await self.client.call_tool(name, arguments, **kwargs)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--task", default="Which active engagements have high risks, and how much of their budget is used?")
    parser.add_argument("--model", default="claude-opus-5-5")
    parser.add_argument("--auto-approve", action="store_true")
    args = parser.parse_args()

    async with Client(SERVER) as mcp:
        listed = (await mcp.list_tools()).tools
        read_only = {t.name for t in listed if t.annotations and t.annotations.read_only_hint}
        gate = Approvals(mcp, read_only, args.auto_approve)
        print(f"Tools from the server: {', '.join(t.name + ('' if t.name in read_only else ' (writes)') for t in listed)}")
        print(f"User: {args.task}\n")

        claude = AsyncAnthropic()
        runner = claude.beta.messages.tool_runner(
            model=args.model,
            max_tokens=16000,
            system="You help a consulting delivery team. Use the engagement tools; never guess figures.",
            tools=[async_mcp_tool(t, gate) for t in listed],
            messages=[{"role": "user", "content": args.task}],
            **fallback_params(args.model),
        )
        async for message in runner:
            for block in message.content:
                if block.type == "tool_use":
                    print(f"  tool call: {block.name}({json.dumps(block.input)})")
                elif block.type == "text" and block.text.strip():
                    print(f"\n{block.text.strip()}\n")
            print(f"  [stop_reason={message.stop_reason} · {describe_usage(message.usage, args.model)}]")
        if message.stop_reason == "refusal":
            print("The request was declined.")


if __name__ == "__main__":
    asyncio.run(main())
