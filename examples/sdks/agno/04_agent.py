"""Task 4 with Agno: an autonomous agent with harness features.

- tool_call_limit is the step limit;
- a tool_hooks function sees every tool call, which is the trace;
- log_risk is wrapped with requires_confirmation=True: the run pauses with requirements, a person
  confirms or rejects each one, and agent.continue_run carries on from the saved run (pause and resume).

    python 04_agent.py [--auto-approve]
"""
import argparse

from _agno import model
from agno.agent import Agent
from agno.tools import tool

from shared import checks, engagements, tasks

parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
args = parser.parse_args()


def trace(function_name, function_call, arguments):
    print(f"  tool: {function_name}({arguments})")
    return function_call(**arguments)


tools = [tool(requires_confirmation=True)(f) if f.__name__ in engagements.WRITE_TOOLS else f for f in engagements.ALL_TOOLS]
agent = Agent(model=model(), instructions=tasks.SYSTEM + " Approval for writes is handled by the system: call log_risk directly, do not ask the user.",
              tools=tools, tool_call_limit=20, tool_hooks=[trace])

run = agent.run(tasks.GOAL)
while run.is_paused:
    for req in run.active_requirements:  # the calls waiting for a person
        call = req.tool_execution
        req.confirm() if checks.approve(call.tool_name, call.tool_args, args.auto_approve) else req.reject()
    run = agent.continue_run(run)
print("\n" + run.content)
checks.agent_ok()
