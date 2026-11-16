"""What every Bedrock example shares: the AWS check, the dry run, tool schemas, and the Converse tool loop.

There is no AWS account on the lab machine, so each script first checks for credentials and prints
`SKIP <task>: ...` and exits 0 when there are none. `--dry-run` builds the first request with throwaway
credentials, checks it against botocore's own model of the API (no network) and stops.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import boto3  # noqa: E402
from botocore.validate import validate_parameters  # noqa: E402
from pydantic import TypeAdapter  # noqa: E402

from shared import config  # noqa: E402,F401  (loads the lab's .env, in case AWS_PROFILE is set there)

REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")  # an inference profile you have access to
DRY_RUN = "--dry-run" in sys.argv


class DryRunStop(Exception):
    """Raised after a dry run has validated a request."""


def require_aws(task: str) -> None:
    """Exit 0 with a SKIP line when there is no AWS account to call (unless this is a dry run)."""
    if DRY_RUN:
        return
    profile, key = os.environ.get("AWS_PROFILE"), os.environ.get("AWS_ACCESS_KEY_ID")
    if not (profile or key) or boto3.Session(profile_name=profile if not key else None).get_credentials() is None:
        print(f"SKIP {task}: needs an AWS account with Bedrock model access (set AWS_PROFILE and AWS_REGION)")
        sys.exit(0)


class Client:
    """A boto3 client; in a dry run every call is validated against the service model and then stops the script."""

    def __init__(self, service: str):
        extra = {"aws_access_key_id": "dry", "aws_secret_access_key": "dry"} if DRY_RUN else {}
        self.client = boto3.client(service, region_name=REGION, **extra)

    def __getattr__(self, operation: str):
        call = getattr(self.client, operation)
        if not DRY_RUN:
            return call

        def dry(**params):
            check(self.client, operation, params)
            raise DryRunStop(operation)
        return dry


def check(client, operation: str, params: dict) -> None:
    """Validate request parameters against the API model, as boto3 does just before it sends them."""
    name = "".join(part.title() for part in operation.split("_"))
    validate_parameters(params, client.meta.service_model.operation_model(name).input_shape)
    print(f"DRYRUN {client.meta.service_model.service_name}.{operation}: request is valid")


def run(task: str, main) -> None:
    """Call main(); in a dry run, a validated first request ends the script cleanly."""
    try:
        main()
    except (DryRunStop, BaseExceptionGroup) as stop:  # async code (the MCP client) wraps it in an exception group
        if isinstance(stop, BaseExceptionGroup) and not stop.subgroup(DryRunStop):
            raise
        print(f"DRYRUN {task}: built and validated its first request, no network used")


def tool_schema(fn) -> dict:
    """JSON schema of a Python function's arguments, from its type hints."""
    return TypeAdapter(fn).json_schema()


def tool_spec(fn) -> dict:
    """A shared Python function as a Converse toolSpec; the description is the docstring before `Args:`."""
    return {"toolSpec": {"name": fn.__name__, "description": fn.__doc__.split("Args:")[0].strip(),
                         "inputSchema": {"json": tool_schema(fn)}}}


def converse_loop(bedrock: Client, system: str, prompt: str, tools: list[dict], run_tool, max_steps: int = 20) -> str:
    """Converse with tool use: call the model, run each tool it asks for with run_tool(name, input), repeat."""
    messages = [{"role": "user", "content": [{"text": prompt}]}]
    for _ in range(max_steps):
        extra = {"toolConfig": {"tools": tools}} if tools else {}  # Bedrock rejects an empty tool list
        reply = bedrock.converse(modelId=MODEL_ID, system=[{"text": system}], messages=messages,
                                 inferenceConfig={"maxTokens": 2048}, **extra)
        message = reply["output"]["message"]
        messages.append(message)
        if reply["stopReason"] != "tool_use":
            return "".join(block.get("text", "") for block in message["content"])
        results = []
        for block in message["content"]:
            if "toolUse" in block:
                use = block["toolUse"]
                results.append({"toolResult": {"toolUseId": use["toolUseId"],
                                               "content": [{"json": run_tool(use["name"], use["input"])}]}})
        messages.append({"role": "user", "content": results})
    return "Step limit reached."


def local_tools(functions):
    """(toolSpecs, runner) for shared Python functions."""
    by_name = {f.__name__: f for f in functions}
    return [tool_spec(f) for f in functions], lambda name, args: by_name[name](**args)


# --- Bedrock Agents (task 4): an agent whose tools are an action group that returns control to the caller ---

def action_group_functions(functions) -> list[dict]:
    """The shared functions as a Bedrock Agents functionSchema (names, descriptions and typed parameters)."""
    types = {"string": "string", "integer": "integer", "number": "number", "boolean": "boolean", "array": "array"}
    out = []
    for fn in functions:
        schema = tool_schema(fn)
        params = {name: {"type": types.get(p.get("type", "string"), "string"), "required": name in schema.get("required", []),
                         "description": p.get("description") or p.get("title", name)}
                  for name, p in schema["properties"].items()}
        out.append({"name": fn.__name__, "description": fn.__doc__.split("Args:")[0].strip(), "parameters": params})
    return out


def create_agent(admin: Client, functions, instruction: str) -> tuple[str, str]:
    """Create, prepare and alias a Bedrock agent whose action group is RETURN_CONTROL; returns (agent_id, alias_id).

    Needs BEDROCK_AGENT_ROLE_ARN: an IAM role Bedrock can assume to invoke the model."""
    import time
    role = os.environ.get("BEDROCK_AGENT_ROLE_ARN", "arn:aws:iam::000000000000:role/BedrockAgentRole")
    agent_id = admin.create_agent(agentName="sdks-engagements", foundationModel=MODEL_ID, instruction=instruction,
                                  agentResourceRoleArn=role, idleSessionTTLInSeconds=600)["agent"]["agentId"]

    def wait_for(status: str) -> None:
        while admin.get_agent(agentId=agent_id)["agent"]["agentStatus"] != status:
            time.sleep(2)

    wait_for("NOT_PREPARED")
    admin.create_agent_action_group(agentId=agent_id, agentVersion="DRAFT", actionGroupName="engagement_tools",
                                    actionGroupExecutor={"customControl": "RETURN_CONTROL"},  # no Lambda: the caller runs the tools
                                    functionSchema={"functions": action_group_functions(functions)})
    admin.prepare_agent(agentId=agent_id)
    wait_for("PREPARED")
    alias = admin.create_agent_alias(agentId=agent_id, agentAliasName="live")["agentAlias"]["agentAliasId"]
    return agent_id, alias


def delete_agent(admin: Client, agent_id: str, alias_id: str) -> None:
    admin.delete_agent_alias(agentId=agent_id, agentAliasId=alias_id)
    admin.delete_agent(agentId=agent_id, skipResourceInUseCheck=True)


def invoke(runtime: Client, agent_id: str, alias_id: str, session_id: str, **request) -> tuple[str, list[dict]]:
    """One invoke_agent call: returns the agent's text and any return-of-control requests (each a function call)."""
    stream = runtime.invoke_agent(agentId=agent_id, agentAliasId=alias_id, sessionId=session_id, **request)["completion"]
    text, calls, invocation_id = "", [], None
    for event in stream:
        if "chunk" in event:
            text += event["chunk"]["bytes"].decode()
        if "returnControl" in event:
            invocation_id = event["returnControl"]["invocationId"]
            calls += [{"invocation_id": invocation_id, **i["functionInvocationInput"]}
                      for i in event["returnControl"]["invocationInputs"] if "functionInvocationInput" in i]
    return text, calls


def control_result(call: dict, result: dict) -> dict:
    """A function's result in the shape invoke_agent's sessionState.returnControlInvocationResults expects."""
    return {"functionResult": {"actionGroup": call["actionGroup"], "function": call["function"],
                               "responseBody": {"TEXT": {"body": json.dumps(result)}}}}


if __name__ == "__main__" and "--self-test" in sys.argv:  # builds every Bedrock Agents request offline and validates it
    from shared import engagements
    DRY_RUN_CLIENTS = {s: boto3.client(s, region_name=REGION, aws_access_key_id="dry", aws_secret_access_key="dry")
                       for s in ("bedrock-agent", "bedrock-agent-runtime", "bedrock-runtime")}
    agent, runtime = DRY_RUN_CLIENTS["bedrock-agent"], DRY_RUN_CLIENTS["bedrock-agent-runtime"]
    check(agent, "create_agent", dict(agentName="sdks-engagements", foundationModel=MODEL_ID, instruction="x" * 50,
                                      agentResourceRoleArn="arn:aws:iam::000000000000:role/r", idleSessionTTLInSeconds=600))
    check(agent, "create_agent_action_group", dict(agentId="ABCDEFGHIJ", agentVersion="DRAFT", actionGroupName="engagement_tools",
                                                   actionGroupExecutor={"customControl": "RETURN_CONTROL"},
                                                   functionSchema={"functions": action_group_functions(engagements.ALL_TOOLS)}))
    check(agent, "prepare_agent", dict(agentId="ABCDEFGHIJ"))
    check(agent, "create_agent_alias", dict(agentId="ABCDEFGHIJ", agentAliasName="live"))
    check(runtime, "invoke_agent", dict(agentId="ABCDEFGHIJ", agentAliasId="ABCDEFGHIJ", sessionId="sdk-session", inputText="hi", enableTrace=True))
    call = {"invocation_id": "i", "actionGroup": "engagement_tools", "function": "log_risk"}
    check(runtime, "invoke_agent", dict(agentId="ABCDEFGHIJ", agentAliasId="ABCDEFGHIJ", sessionId="sdk-session", sessionState={
        "invocationId": "i", "returnControlInvocationResults": [control_result(call, {"logged": {}})]}))
    check(agent, "delete_agent", dict(agentId="ABCDEFGHIJ", skipResourceInUseCheck=True))
    print("SELFTEST ok: every Bedrock Agents request validates against the API model")
