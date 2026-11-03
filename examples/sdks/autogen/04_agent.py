"""Task 4 in AutoGen: an autonomous agent with a step limit (max_tool_iterations), a trace of every tool call (from
the run_stream events), and human approval before the write tool. AssistantAgent has no approval hook for tools,
so the gate lives in the tool function itself: it asks first and only then writes.

    python 04_agent.py [--auto-approve]
"""
import argparse
import asyncio
from typing import Literal

from ag_common import azure_client
from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.messages import ToolCallRequestEvent
from autogen_agentchat.base import TaskResult
from shared import checks, engagements, tasks

MAX_STEPS = 10


def make_log_risk(auto_approve: bool):
    def log_risk(engagement_id: str, title: str, severity: Literal["low", "medium", "high"], owner: str) -> dict:
        """Record a new risk on an active engagement. This WRITES data: a person must approve it first."""
        args = {"engagement_id": engagement_id, "title": title, "severity": severity, "owner": owner}
        if not checks.approve("log_risk", args, auto_approve):
            return {"error": "A person declined this call. Do not retry it."}
        return engagements.log_risk(**args)
    return log_risk


async def main(auto_approve: bool) -> None:
    client = azure_client()
    agent = AssistantAgent("reviewer", model_client=client, system_message=tasks.SYSTEM, max_tool_iterations=MAX_STEPS,
                           tools=[*engagements.READ_TOOLS, make_log_risk(auto_approve)], reflect_on_tool_use=True)
    answer = ""
    async for event in agent.run_stream(task=tasks.GOAL):
        if isinstance(event, ToolCallRequestEvent):
            for call in event.content:
                print(f"  tool call: {call.name}({call.arguments})")
        elif isinstance(event, TaskResult):
            answer = str(event.messages[-1].content)
    print(f"\n{answer}")
    checks.agent_ok()
    await client.close()


parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
asyncio.run(main(parser.parse_args().auto_approve))
