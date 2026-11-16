"""The area's shared pieces: a short tool loop where Claude answers one task through an MCP server's read-only tools.

Standard library plus the Anthropic SDK and the MCP Python SDK. Only tools on the allow-list are shown to the model,
and a call to any other name is refused here, before it reaches the server, so nothing that writes can run.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack
from common import config  # noqa: E402

MAX_TURNS = 8
MAX_RESULT_CHARS = 6000  # keeps each tool result, and so the spend, small


def text_of(result: Any) -> str:
    """The text of a result, including text held in an embedded resource (GitHub returns files that way)."""
    parts = []
    for c in result.content:
        inner = getattr(c, "resource", None)
        parts.append(getattr(c, "text", None) or getattr(inner, "text", None) or "")
    return "\n".join(parts)


async def answer(mcp: Any, task: str, allowed: set[str], system: str = "") -> tuple[str, list[str]]:
    """Run the loop. Returns Claude's final answer and the names of the tools it called."""
    from anthropic import AsyncAnthropic

    listed = (await mcp.list_tools()).tools
    tools = [{"name": t.name, "description": (t.description or "")[:800], "input_schema": t.input_schema}
             for t in listed if t.name in allowed]
    print(f"  {len(listed)} tools on the server, {len(tools)} on the allow-list: {', '.join(t['name'] for t in tools)}")
    claude = AsyncAnthropic()
    messages: list[dict] = [{"role": "user", "content": task}]
    called: list[str] = []
    text = ""
    for _ in range(MAX_TURNS):
        reply = await claude.messages.create(
            model=config.CLAUDE_MODEL, max_tokens=1000, tools=tools, messages=messages,
            system=system + " Use the tools; never guess. Answer briefly.")
        messages.append({"role": "assistant", "content": reply.content})
        text = "".join(b.text for b in reply.content if b.type == "text")
        uses = [b for b in reply.content if b.type == "tool_use"]
        if not uses:
            break
        results = []
        for use in uses:
            called.append(use.name)
            print(f"  tool call: {use.name}({json.dumps(use.input)[:150]})")
            if use.name not in allowed:
                out, is_error = f"{use.name} is not allowed: read-only tools only.", True
            else:
                res = await mcp.call_tool(use.name, use.input)
                out, is_error = text_of(res)[:MAX_RESULT_CHARS], bool(res.is_error)
            results.append({"type": "tool_result", "tool_use_id": use.id, "content": out, "is_error": is_error})
        messages.append({"role": "user", "content": results})
    print(f"  answer: {text.strip()[:300]}")
    return text, called


def docker_ready() -> bool:
    try:
        return subprocess.run(["docker", "info"], capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False
