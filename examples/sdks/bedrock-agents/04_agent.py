"""Task 4 with Bedrock Agents: a managed agent whose tools are an action group set to RETURN_CONTROL.

- Bedrock runs the agent loop; each tool call comes back to this script as a `returnControl` event, and the script
  runs the function and answers with sessionState.returnControlInvocationResults (pause and resume);
- that is where the human approval before log_risk sits;
- the trace is the loop's own tool calls; Bedrock Agents has no step-limit setting, so the script caps the
  number of returns of control (MAX_CALLS) and deletes the agent when it is done.

Needs BEDROCK_AGENT_ROLE_ARN (an IAM role Bedrock can assume). Creates and deletes its own agent.

    python 04_agent.py [--auto-approve] [--dry-run]
"""
import argparse
import uuid

import _bedrock as b

from shared import checks, engagements, tasks

MAX_CALLS = 20
parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
parser.add_argument("--dry-run", action="store_true")
args = parser.parse_args()


def main() -> None:
    admin, runtime = b.Client("bedrock-agent"), b.Client("bedrock-agent-runtime")
    by_name = {f.__name__: f for f in engagements.ALL_TOOLS}
    instruction = tasks.SYSTEM + " Approval for writes is handled by the system: call log_risk directly, do not ask the user."
    agent_id, alias_id = b.create_agent(admin, engagements.ALL_TOOLS, instruction)
    try:
        session, request, calls_made = uuid.uuid4().hex, {"inputText": tasks.GOAL}, 0
        while True:
            text, calls = b.invoke(runtime, agent_id, alias_id, session, **request)
            if not calls:
                break
            results = []
            for call in calls:
                arguments = {p["name"]: p["value"] for p in call["parameters"]}
                calls_made += 1
                print(f"  [call {calls_made}] {call['function']}({arguments})")
                if calls_made > MAX_CALLS:
                    result = {"error": "Step limit reached. Stop and report what you have done."}
                elif call["function"] in engagements.WRITE_TOOLS and not checks.approve(call["function"], arguments, args.auto_approve):
                    result = {"error": "A person declined this call. Do not retry it; say it was not done."}
                else:
                    result = by_name[call["function"]](**arguments)
                results.append(b.control_result(call, result))
            request = {"sessionState": {"invocationId": calls[0]["invocation_id"], "returnControlInvocationResults": results}}
        print("\n" + text)
        checks.agent_ok()
    finally:
        b.delete_agent(admin, agent_id, alias_id)


b.require_aws("04_agent")
b.run("04_agent", main)
