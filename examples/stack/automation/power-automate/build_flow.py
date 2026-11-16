"""Writes flow.definition.json, the cloud flow as a Power Automate export holds it (Logic Apps workflow definition language).

Run: python build_flow.py. Prompts and the model come from ../shared.py. The key is a flow parameter, never a literal.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import shared  # noqa: E402

RETRY = {"type": "exponential", "count": 4, "interval": "PT2S", "minimumInterval": "PT1S", "maximumInterval": "PT30S"}
EMAIL = "From: @{items('For_each_email')?['from']}\nSubject: @{items('For_each_email')?['subject']}\n\n@{items('For_each_email')?['body']}"


def claude(system: str, max_tokens: int, run_after: dict) -> dict:
    return {
        "type": "Http", "runAfter": run_after,
        "inputs": {
            "method": "POST", "uri": shared.API_URL,
            "headers": {"x-api-key": "@parameters('AnthropicApiKey')", "anthropic-version": "2023-06-01",
                        "content-type": "application/json"},
            "body": {"model": "@parameters('Model')", "max_tokens": max_tokens, "thinking": {"type": "disabled"},
                     "system": system, "messages": [{"role": "user", "content": EMAIL}]},
            "retryPolicy": RETRY},
        "runtimeConfiguration": {"secureData": {"properties": ["inputs", "outputs"]}},
    }


definition = {
    "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
    "contentVersion": "1.0.0.0",
    "parameters": {
        "$connections": {"defaultValue": {}, "type": "Object"},
        "$authentication": {"defaultValue": {}, "type": "SecureObject"},
        "AnthropicApiKey": {"type": "SecureString", "metadata": {"description": "Set from a Power Platform secret environment variable."}},
        "Model": {"type": "String", "defaultValue": shared.MODEL},
        "CrmUrl": {"type": "String", "metadata": {"description": "A CRM endpoint to log to (the flaky step)."}},
    },
    "triggers": {
        "manual": {"type": "Request", "kind": "Http", "inputs": {"schema": {
            "type": "object", "properties": {"emails": {"type": "array", "items": {"type": "object", "properties": {
                k: {"type": "string"} for k in ("id", "from", "subject", "body")}}}}}}}},
    "actions": {
        "Initialize_results": {"type": "InitializeVariable", "runAfter": {}, "inputs": {"variables": [
            {"name": "results", "type": "array", "value": []}]}},
        "Initialize_category": {"type": "InitializeVariable", "runAfter": {"Initialize_results": ["Succeeded"]},
                                "inputs": {"variables": [{"name": "category", "type": "string", "value": ""}]}},
        "Initialize_urgency": {"type": "InitializeVariable", "runAfter": {"Initialize_category": ["Succeeded"]},
                               "inputs": {"variables": [{"name": "urgency", "type": "string", "value": ""}]}},
        "For_each_email": {
            "type": "Foreach", "foreach": "@triggerBody()?['emails']", "runAfter": {"Initialize_urgency": ["Succeeded"]},
            "runtimeConfiguration": {"concurrency": {"repetitions": 1}},
            "actions": {
                "Classify": claude(shared.CLASSIFY_SYSTEM, 200, {}),
                "Parse_classification": {"type": "ParseJson", "runAfter": {"Classify": ["Succeeded"]}, "inputs": {
                    "content": "@first(body('Classify')?['content'])?['text']",
                    "schema": {"type": "object", "properties": {"category": {"type": "string"}, "urgency": {"type": "string"}}}}},
                "Set_category": {"type": "SetVariable", "runAfter": {"Parse_classification": ["Succeeded"]},
                                 "inputs": {"name": "category", "value": "@toLower(body('Parse_classification')?['category'])"}},
                "Set_urgency": {"type": "SetVariable", "runAfter": {"Set_category": ["Succeeded"]},
                                "inputs": {"name": "urgency", "value": "@toLower(body('Parse_classification')?['urgency'])"}},
                "Is_spam": {
                    "type": "If", "runAfter": {"Set_urgency": ["Succeeded"]},
                    "expression": {"equals": ["@variables('category')", "spam"]},
                    "actions": {"Drop_spam": {"type": "AppendToArrayVariable", "runAfter": {}, "inputs": {
                        "name": "results", "value": {"id": "@items('For_each_email')?['id']", "action": "drop",
                                                     "category": "@variables('category')", "urgency": "@variables('urgency')"}}}},
                    "else": {"actions": {"Is_urgent": {
                        "type": "If", "runAfter": {},
                        "expression": {"equals": ["@variables('urgency')", "high"]},
                        "actions": {"Escalate": {"type": "AppendToArrayVariable", "runAfter": {}, "inputs": {
                            "name": "results", "value": {
                                "id": "@items('For_each_email')?['id']", "action": "escalate",
                                "category": "@variables('category')", "urgency": "@variables('urgency')",
                                "escalation": "@concat('ESCALATE to on-call team: ', items('For_each_email')?['subject'], ' (', items('For_each_email')?['from'], ')')"}}}},
                        "else": {"actions": {
                            "Draft_reply": claude(shared.REPLY_SYSTEM, 150, {}),
                            "Add_reply": {"type": "AppendToArrayVariable", "runAfter": {"Draft_reply": ["Succeeded"]},
                                          "inputs": {"name": "results", "value": {
                                              "id": "@items('For_each_email')?['id']", "action": "reply",
                                              "category": "@variables('category')", "urgency": "@variables('urgency')",
                                              "reply": "@trim(first(body('Draft_reply')?['content'])?['text'])"}}}}}}}}},
            }},
        "Log_to_CRM": {
            "type": "Http", "runAfter": {"For_each_email": ["Succeeded"]},
            "inputs": {"method": "POST", "uri": "@parameters('CrmUrl')", "body": {"count": "@length(variables('results'))"},
                       "retryPolicy": {"type": "fixed", "count": 3, "interval": "PT5S"}}},
        "Response": {"type": "Response", "kind": "Http", "runAfter": {"Log_to_CRM": ["Succeeded"]}, "inputs": {
            "statusCode": 200, "body": {"results": "@variables('results')",
                                        "flaky_attempts": "@add(1, length(coalesce(actions('Log_to_CRM')?['retryHistory'], json('[]'))))"}}},
    },
    "outputs": {},
}
# retryHistory lists each retry of an action in the run, so attempts = retries + 1.
export = {"schemaVersion": "1.0.0.0", "properties": {
    "displayName": "Email triage (LLM Lab)", "definition": definition, "connectionReferences": {},
    "flowFailureAlertSubscribed": False, "isManaged": False}}
Path(__file__).with_name("flow.definition.json").write_text(json.dumps(export, indent=2) + "\n")
print("wrote flow.definition.json")
