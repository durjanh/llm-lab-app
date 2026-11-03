"""Task 4 with the OpenAI Agents SDK: the Runner is the harness.

log_risk is a function tool with needs_approval=True: when the agent calls it, the run stops with an
interruption. The script asks a person, records approve or reject on the run state, and resumes the run
from that state. max_turns is the step limit; the Trace hook prints every tool call.
"""
import argparse
import json

from _common import Trace, get_engagement, log_risk, model, search_engagements
from agents import Agent, MaxTurnsExceeded, Runner
from shared import checks, tasks

parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
args = parser.parse_args()

agent = Agent(name="reviewer", instructions=tasks.SYSTEM, model=model(), tools=[search_engagements, get_engagement, log_risk])
try:
    result = Runner.run_sync(agent, tasks.GOAL, max_turns=12, hooks=Trace())
    while result.interruptions:  # paused for approval
        state = result.to_state()
        for item in result.interruptions:
            call_args = json.loads(getattr(item.raw_item, "arguments", "{}") or "{}")
            if checks.approve(item.tool_name, call_args, args.auto_approve):
                state.approve(item)
            else:
                state.reject(item)
        result = Runner.run_sync(agent, state, max_turns=12, hooks=Trace())
    print(result.final_output)
except MaxTurnsExceeded:
    print("Stopped: reached the 12-turn limit.")
checks.agent_ok()
