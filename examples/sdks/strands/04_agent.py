"""Task 4 with Strands Agents: an autonomous agent with harness features, all in one hook.

- a BeforeToolCallEvent hook traces every tool call;
- the same hook asks a person before log_risk runs, and cancels the call (cancel_tool) when they say no;
- the hook also counts calls and cancels any past MAX_CALLS: Strands has no step-limit setting, so this is the limit.

    python 04_agent.py [--auto-approve]
"""
import argparse

from _strands import as_tools, model
from strands import Agent
from strands.hooks import BeforeToolCallEvent

from shared import checks, engagements, tasks

MAX_CALLS = 20
parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
args = parser.parse_args()
calls = 0


def gate(event: BeforeToolCallEvent) -> None:
    global calls
    calls += 1
    name, tool_input = event.tool_use["name"], event.tool_use["input"]
    print(f"  [call {calls}] {name}({tool_input})")
    if calls > MAX_CALLS:
        event.cancel_tool = "Step limit reached. Stop and report what you have done."
    elif name in engagements.WRITE_TOOLS and not checks.approve(name, tool_input, args.auto_approve):
        event.cancel_tool = "A person declined this call. Do not retry it; say it was not done."


agent = Agent(model=model(), system_prompt=tasks.SYSTEM, tools=as_tools(engagements.ALL_TOOLS),
              hooks=[gate], callback_handler=None)
result = agent(tasks.GOAL)
print("\n" + str(result))
checks.agent_ok()
