"""Writes blueprint.json, the Make scenario, from the shared prompts. Run: python build_blueprint.py

One webhook call is one email. The scenario answers each call with its outcome through a Webhook response module at
the end of whichever route ran. The Anthropic key is a header value you type into the HTTP module after import.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import shared  # noqa: E402

USER = 'From: {{1.from}}\nSubject: {{1.subject}}\n\n{{1.body}}'


def break_handler(module_id: int) -> list:
    """Make's retry: the Break directive stores the run as incomplete and retries it up to 3 times, a minute apart."""
    return [{"id": 90 + module_id, "module": "builtin:Break", "version": 1, "parameters": {},
             "mapper": {"count": "3", "interval": "1", "autoResume": True}, "metadata": {"designer": {"x": 0, "y": 0}}}]


def claude(module_id: int, system: str, max_tokens: int, x: int, y: int) -> dict:
    body = {"model": shared.MODEL, "max_tokens": max_tokens, "thinking": {"type": "disabled"}, "system": system,
            "messages": [{"role": "user", "content": USER}]}
    return {"id": module_id, "module": "http:ActionSendData", "version": 3, "parameters": {"handleErrors": True},
            "mapper": {"url": shared.API_URL, "method": "post", "headers": [
                {"name": "x-api-key", "value": "PASTE_KEY_AFTER_IMPORT"},
                {"name": "anthropic-version", "value": "2023-06-01"}],
                "contentType": "json", "bodyType": "raw", "parseResponse": True, "timeout": "40",
                "data": json.dumps(body)},
            "onerror": break_handler(module_id), "metadata": {"designer": {"x": x, "y": y}}}


def respond(module_id: int, body: str, x: int, y: int) -> dict:
    return {"id": module_id, "module": "gateway:WebhookRespond", "version": 1, "parameters": {}, "mapper": {
        "status": "200", "body": body, "headers": [{"key": "Content-Type", "value": "application/x-www-form-urlencoded"}]},
        "metadata": {"designer": {"x": x, "y": y}}}


def cond(a: str, b: str) -> dict:
    return {"conditions": [[{"a": a, "b": b, "o": "text:equal"}]]}


COMMON = "id={{1.id}}&category={{encodeURL(4.category)}}&urgency={{encodeURL(4.urgency)}}"
flow = [
    {"id": 1, "module": "gateway:CustomWebHook", "version": 1, "parameters": {"hook": "REPLACE_WITH_YOUR_HOOK_ID", "maxResults": 1},
     "mapper": {}, "metadata": {"designer": {"x": 0, "y": 0}}},
    claude(3, shared.CLASSIFY_SYSTEM, 200, 300, 0),
    {"id": 4, "module": "util:SetVariables", "version": 1, "parameters": {}, "mapper": {"scope": "roundtrip", "variables": [
        {"name": "category", "value": "{{lower(parseJSON(3.data.content[1].text).category)}}"},
        {"name": "urgency", "value": "{{lower(parseJSON(3.data.content[1].text).urgency)}}"}]},
     "metadata": {"designer": {"x": 600, "y": 0}}},
    {"id": 5, "module": "builtin:BasicRouter", "version": 1, "mapper": None, "metadata": {"designer": {"x": 900, "y": 0}},
     "routes": [
         {"flow": [respond(6, COMMON + "&action=drop", 1200, -300)]},
         {"flow": [respond(7, COMMON + "&action=escalate&escalation={{encodeURL(concat(\"ESCALATE to on-call team: \"; 1.subject; \" (\"; 1.from; \")\"))}}", 1200, 0)]},
         {"flow": [claude(8, shared.REPLY_SYSTEM, 150, 1200, 300),
                   respond(9, COMMON + "&action=reply&reply={{encodeURL(trim(8.data.content[1].text))}}", 1500, 300)]}]},
]
# Route filters: the first two routes have one, the last is the fallback (no filter, "else").
flow[3]["routes"][0]["flow"][0]["filter"] = {"name": "Spam", **cond("{{4.category}}", "spam")}
flow[3]["routes"][1]["flow"][0]["filter"] = {"name": "Urgent", "conditions": [[
    {"a": "{{4.category}}", "b": "spam", "o": "text:notequal"}, {"a": "{{4.urgency}}", "b": "high", "o": "text:equal"}]]}
flow[3]["routes"][2]["flow"][0]["filter"] = {"name": "Everything else", "conditions": [[
    {"a": "{{4.category}}", "b": "spam", "o": "text:notequal"}, {"a": "{{4.urgency}}", "b": "high", "o": "text:notequal"}]]}

blueprint = {"name": "Email triage (LLM Lab)", "flow": flow, "metadata": {
    "instant": True, "version": 1, "scenario": {"roundtrips": 1, "maxErrors": 3, "autoCommit": True, "autoCommitTriggerLast": True,
                                                "sequential": False, "slots": None, "confidential": False, "dataloss": False,
                                                "dlq": False, "freshVariables": False},
    "designer": {"orphans": []}}}
Path(__file__).with_name("blueprint.json").write_text(json.dumps(blueprint, indent=2) + "\n")
print("wrote blueprint.json")
