"""The support desk agent (lab page /support-desk) on the Claude Agent SDK: the same four tools, run by Claude Code.

The lab's service writes the agent loop by hand. Here the SDK runs it, and what is left to you is the tools and two hooks:

  mcp_servers      the four tools as an in-process MCP server (create_sdk_mcp_server and @tool): get_customer,
                   lookup_order, process_refund and escalate_to_human. Each returns isError and text content, and an
                   error carries an errorCategory and isRetryable. They are named mcp__support__<tool>.
  tools / allowed  tools=[] turns off every built-in tool (no Bash, no files), and allowed_tools names only the four
                   support tools: least privilege. can_use_tool refuses anything else.
  PreToolUse       denies process_refund above $500 with a reason that says to escalate. The model can ask, the hook decides.
  PostToolUse      normalises dates before the model sees them: Unix timestamps and "03/11/2026" become ISO 8601.
  max_turns        the loop's safety stop. The run ends when Claude Code reaches end_turn.

    .venv/bin/python support_agent_sdk.py                                  # a refund of $64.50, which goes through
    .venv/bin/python support_agent_sdk.py --task big_refund                # over $500: the hook denies it
    .venv/bin/python support_agent_sdk.py "Hi, I'm mira.okafor@example.com. Where is order LF-2002?"
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, HookMatcher, PermissionResultAllow,
                              PermissionResultDeny, ResultMessage, SystemMessage, TextBlock, ToolPermissionContext,
                              ToolResultBlock, ToolUseBlock, UserMessage, create_sdk_mcp_server, tool)

ROOT = Path(__file__).resolve().parents[2]
REFUND_LIMIT_USD = 500
TOOLS = ["get_customer", "lookup_order", "process_refund", "escalate_to_human"]
ALLOW = [f"mcp__support__{name}" for name in TOOLS]  # an SDK tool is named mcp__<server>__<tool>
TASKS = {
    "refund": "Hi, I'm mira.okafor@example.com. The planter set in order LF-2001 arrived cracked. Please refund it.",
    "big_refund": "I'm tom.bellweather@example.com. The oak dining bench in order LF-2003 is wobbly and I want the full "
                  "$689 back.",
    "human": "I want to talk to a real person please.",
}
SYSTEM = (
    "You are the customer support agent for Larkfield Home Goods, an invented online shop. Verify the customer with "
    "get_customer before you look up an order or refund anything. You may refund up to $500 on a delivered order. "
    "Above that, call escalate_to_human with the issue, the amount and a recommended action, because the person who "
    "picks it up cannot see this conversation. If the customer asks for a person, escalate at once. A tool error has an "
    "errorCategory: retry a transient one once, explain a business one, and do not retry a permission one."
)

# Invented data, enough for the tools to work. The order system mixes date formats on purpose.
CUSTOMERS = {"mira.okafor@example.com": {"customer_id": "C-101", "name": "Mira Okafor"},
             "tom.bellweather@example.com": {"customer_id": "C-102", "name": "Tom Bellweather"}}
ORDERS = {"LF-2001": {"order_id": "LF-2001", "customer_id": "C-101", "status": 4, "total_usd": 64.5,
                      "placed_at": 1793183520, "delivered_on": "03/11/2026"},  # Unix seconds, and day/month/year
          "LF-2002": {"order_id": "LF-2002", "customer_id": "C-101", "status": 3, "total_usd": 67.0,
                      "placed_at": 1794240000, "delivered_on": None},
          "LF-2003": {"order_id": "LF-2003", "customer_id": "C-102", "status": 4, "total_usd": 689.0,
                      "placed_at": "2026-10-29T09:00:00Z", "delivered_on": "2026-11-05T13:10:00Z"}}
STATUS = {1: "placed", 2: "packed", 3: "shipped", 4: "delivered", 5: "cancelled", 6: "returned"}


def reply(structured: dict[str, Any], error: bool = False) -> dict[str, Any]:
    """An MCP tool result: text content, with is_error set for a failure."""
    return {"content": [{"type": "text", "text": json.dumps(structured)}], **({"is_error": True} if error else {})}


def failure(category: str, retryable: bool, message: str, **extra: Any) -> dict[str, Any]:
    """A structured tool error. The message is safe to read to the customer."""
    return reply({"isError": True, "errorCategory": category, "isRetryable": retryable, "message": message, **extra}, True)


def make_tools(state: dict[str, Any]):
    """The four support tools. `state` holds the verified customer for this conversation."""
    @tool("get_customer", "Find and verify the customer by email. Call this first, before any order look-up or refund. "
          "Returns the customer_id, or no_match.", {"type": "object", "properties": {"email": {"type": "string"}},
                                                    "required": ["email"]})
    async def get_customer(args: dict[str, Any]) -> dict[str, Any]:
        found = CUSTOMERS.get(str(args.get("email", "")).strip().lower())
        if not found:
            return reply({"status": "no_match", "matches": 0})  # a valid empty result, not an error
        state["verified"] = found["customer_id"]
        return reply({"status": "verified", **found})

    @tool("lookup_order", "Get one order by order_id (like LF-2001) for the verified customer: status, total in "
          "dollars, dates. Cannot change anything.", {"type": "object", "properties": {"order_id": {"type": "string"}},
                                                      "required": ["order_id"]})
    async def lookup_order(args: dict[str, Any]) -> dict[str, Any]:
        if not state.get("verified"):
            return failure("permission", False, "The customer has not been verified. Call get_customer first.")
        order = ORDERS.get(str(args.get("order_id", "")).strip().upper())
        if not order or order["customer_id"] != state["verified"]:
            return failure("validation", False, "No order with that id was found on this account.")
        return reply(order)

    @tool("process_refund", "Refund an amount in dollars on a delivered order of the verified customer. Up to $500 only: "
          "use escalate_to_human above that.",
          {"type": "object", "properties": {"order_id": {"type": "string"}, "amount_usd": {"type": "number"},
                                            "reason": {"type": "string"}}, "required": ["order_id", "amount_usd", "reason"]})
    async def process_refund(args: dict[str, Any]) -> dict[str, Any]:
        order = ORDERS.get(str(args.get("order_id", "")).strip().upper())
        if not state.get("verified") or not order or order["customer_id"] != state["verified"]:
            return failure("permission", False, "Verify the customer, and use one of their order ids.")
        if order["status"] != 4:
            return failure("business", False, "This order has not been delivered, so it cannot be refunded yet.")
        return reply({"refund_id": "RF-0001", "order_id": order["order_id"], "amount_usd": args["amount_usd"]})

    @tool("escalate_to_human", "Hand the case to a person who cannot see this conversation. Give the issue, the root "
          "cause, the amount, what you tried and your recommended action.",
          {"type": "object", "properties": {"reason": {"type": "string"}, "issue": {"type": "string"},
                                            "root_cause": {"type": "string"}, "amount_usd": {"type": "number"},
                                            "tried": {"type": "array", "items": {"type": "string"}},
                                            "recommended_action": {"type": "string"}},
                           "required": ["reason", "issue", "recommended_action"]})
    async def escalate_to_human(args: dict[str, Any]) -> dict[str, Any]:
        return reply({"ticket_id": "ESC-0001", "handoff": {"customer_id": state.get("verified"), **args},
                      "message": "A colleague will pick this up within one working day."})

    return [get_customer, lookup_order, process_refund, escalate_to_human]


async def limit_refunds(data: dict, tool_use_id: str | None, context: Any) -> dict:
    """PreToolUse: a refund over the limit never runs. The reason goes back to the model, which then escalates."""
    amount = data.get("tool_input", {}).get("amount_usd")
    if isinstance(amount, (int, float)) and not isinstance(amount, bool) and amount > REFUND_LIMIT_USD:
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": f"Refunds over ${REFUND_LIMIT_USD} need a person. Call escalate_to_human with "
                                        f"the reason: refund of ${amount:.2f} is over the limit."}}
    return {}


def iso(value: Any) -> Any:
    """A Unix timestamp or a day/month/year string as ISO 8601. Anything else is returned as it came."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(value, str) and (m := re.fullmatch(r"(\d{2})/(\d{2})/(\d{4})", value)):
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return value


def clean(data: Any, key: str = "") -> Any:
    if isinstance(data, dict):
        return {k: clean(v, k) for k, v in data.items()}
    if isinstance(data, list):
        return [clean(v, key) for v in data]
    if key.endswith(("_at", "_on")):
        return iso(data)
    if key == "status" and isinstance(data, int) and not isinstance(data, bool):
        return STATUS.get(data, data)
    return data


async def normalise_dates(data: dict, tool_use_id: str | None, context: Any) -> dict:
    """PostToolUse: rewrite the tool's output before the model reads it, so every date is ISO 8601."""
    response = data.get("tool_response")
    blocks = response if isinstance(response, list) else (response or {}).get("content") if isinstance(response, dict) else None
    text = "".join(b.get("text", "") for b in blocks or [] if isinstance(b, dict))
    try:
        body = json.loads(text)
    except ValueError:
        return {}
    if clean(body) == body:
        return {}
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                   "updatedMCPToolOutput": [{"type": "text", "text": json.dumps(clean(body))}]}}


async def only_support_tools(name: str, args: dict[str, Any], ctx: ToolPermissionContext):
    """Anything outside the four support tools is refused."""
    return PermissionResultAllow() if name in ALLOW else PermissionResultDeny(message="Only the support tools are allowed.")


def emit(event: dict) -> None:
    if event["type"] == "text":
        print(f"\n{event['text']}\n", flush=True)
    elif event["type"] == "tool_use":
        print(f"→ {event['name']} {json.dumps(event['input'])[:160]}", flush=True)
    elif event["type"] == "result":
        print(f"  {'✗' if event['is_error'] else '←'} {event['content'][:200]}", flush=True)


def api_key() -> str:
    """ANTHROPIC_API_KEY from the environment, or from the lab's .env file."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ["ANTHROPIC_API_KEY"]
    env = ROOT / ".env"
    for line in env.read_text().splitlines() if env.exists() else []:
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("Set ANTHROPIC_API_KEY, or put it in the lab's .env file.")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("prompt", nargs="?", help="your own message as the customer, instead of a task")
    parser.add_argument("--task", choices=list(TASKS), default="refund")
    parser.add_argument("--model", default="claude-haiku-5-5")
    parser.add_argument("--budget", type=float, default=0.25, help="the SDK stops the run at this many dollars")
    parser.add_argument("--max-turns", type=int, default=12)
    args = parser.parse_args()

    state: dict[str, Any] = {}
    work = Path(tempfile.mkdtemp(prefix="support-agent-sdk-"))  # an empty folder: the agent has no files to reach
    config = Path(tempfile.mkdtemp(prefix="claude-config-"))  # keeps your own ~/.claude out of the run
    options = ClaudeAgentOptions(
        cwd=str(work),
        model=args.model,
        system_prompt=SYSTEM,
        tools=[],  # no built-in tools at all
        allowed_tools=ALLOW,
        can_use_tool=only_support_tools,
        mcp_servers={"support": create_sdk_mcp_server("support", tools=make_tools(state))},
        hooks={"PreToolUse": [HookMatcher(matcher="mcp__support__process_refund", hooks=[limit_refunds])],
               "PostToolUse": [HookMatcher(matcher="mcp__support__.*", hooks=[normalise_dates])]},
        setting_sources=[],
        max_turns=args.max_turns,
        max_budget_usd=args.budget,
        env={"ANTHROPIC_API_KEY": api_key(), "CLAUDE_CONFIG_DIR": str(config)},
    )
    prompt = args.prompt or TASKS[args.task]
    print(f"Customer: {prompt}\n")
    names: dict[str, str] = {}
    try:
        async with ClaudeSDKClient(options=options) as client:
            await client.query(prompt)
            async for msg in client.receive_response():
                if isinstance(msg, SystemMessage) and msg.subtype == "init":
                    print(f"Tools: {', '.join(msg.data.get('tools', []))}", flush=True)
                elif isinstance(msg, AssistantMessage):
                    for b in msg.content:
                        if isinstance(b, TextBlock) and b.text.strip():
                            emit({"type": "text", "text": b.text.strip()})
                        elif isinstance(b, ToolUseBlock):
                            names[b.id] = b.name
                            emit({"type": "tool_use", "name": b.name, "input": b.input})
                elif isinstance(msg, UserMessage) and isinstance(msg.content, list):
                    for b in msg.content:
                        if isinstance(b, ToolResultBlock):
                            content = b.content if isinstance(b.content, str) else "\n".join(
                                c.get("text", "") for c in b.content or [] if isinstance(c, dict))
                            emit({"type": "result", "content": content or "", "is_error": bool(b.is_error)})
                elif isinstance(msg, ResultMessage):
                    print(f"\nOutcome: {msg.subtype}. {msg.num_turns} turns, {msg.duration_ms / 1000:.1f} s, "
                          f"${msg.total_cost_usd or 0:.4f} (reported by the SDK).")
    finally:
        shutil.rmtree(config, ignore_errors=True)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
