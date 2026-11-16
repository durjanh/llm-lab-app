"""Task 4 with CAMEL: an autonomous agent with harness features.

- max_iteration is the step limit;
- every ToolCallingRecord in the reply is the trace;
- log_risk is an external tool: CAMEL does not run it, it stops and returns the request in
  response.info["external_tool_call_requests"]. A person answers, the script runs the call itself, records the result
  in the agent's memory and steps again (pause and resume).

    python 04_agent.py [--auto-approve]
"""
import argparse

from _camel import as_tools, model
from camel.agents import ChatAgent

from shared import checks, engagements, tasks

parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
args = parser.parse_args()

agent = ChatAgent(system_message=tasks.SYSTEM + " Approval for writes is handled by the system: call log_risk directly, do not ask the user.",
                  model=model(), tools=as_tools(engagements.READ_TOOLS), max_iteration=20,
                  external_tools=as_tools([engagements.log_risk]))


def show(response) -> None:
    for record in response.info.get("tool_calls", []):
        print(f"  tool: {record.tool_name}({record.args})")


response = agent.step(tasks.GOAL)
show(response)
while response.info.get("external_tool_call_requests"):
    for call in response.info["external_tool_call_requests"]:  # the calls waiting for a person
        if checks.approve(call.tool_name, call.args, args.auto_approve):
            result = engagements.log_risk(**call.args)
        else:
            result = {"error": "A person declined this call. Do not retry it; say it was not done."}
        agent._record_tool_calling(call.tool_name, call.args, result, call.tool_call_id)  # the result goes back to the model
    response = agent.step("Carry on with the goal and then report what you did and why.")
    show(response)
print("\n" + response.msgs[0].content)
checks.agent_ok()
