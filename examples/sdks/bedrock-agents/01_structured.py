"""Task 1 with Bedrock: one Converse call, a typed answer (a forced tool whose input schema is the model)."""
import _bedrock as b

from shared import checks, tasks


def main() -> None:
    bedrock = b.Client("bedrock-runtime")
    tool = {"toolSpec": {"name": "triage", "description": "Record how the complaint should be routed.",
                         "inputSchema": {"json": tasks.Triage.model_json_schema()}}}
    reply = bedrock.converse(modelId=b.MODEL_ID, system=[{"text": tasks.SYSTEM}],
                             messages=[{"role": "user", "content": [{"text": tasks.TRIAGE_PROMPT}]}],
                             toolConfig={"tools": [tool], "toolChoice": {"tool": {"name": "triage"}}})  # the model must call it
    arguments = next(c["toolUse"]["input"] for c in reply["output"]["message"]["content"] if "toolUse" in c)
    triage = tasks.Triage.model_validate(arguments)  # Converse does not validate; pydantic does
    print(triage.model_dump_json(indent=2))
    checks.triage_ok(triage)


b.require_aws("01_structured")
b.run("01_structured", main)
