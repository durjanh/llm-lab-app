"""Writes workflow.json (the n8n workflow) from the shared prompts and emails. Run: python build_workflow.py

The workflow holds no key. The HTTP Request nodes read ANTHROPIC_API_KEY from the container's environment when they run.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import shared  # noqa: E402

KEY = "={{ $env.ANTHROPIC_API_KEY }}"


def claude_node(name, pos, system, user_expr, max_tokens):
    return {
        "id": name.lower().replace(" ", "-"), "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
        "position": pos, "retryOnFail": True, "maxTries": 3, "waitBetweenTries": 1000,
        "parameters": {
            "method": "POST", "url": shared.API_URL, "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "x-api-key", "value": KEY},
                {"name": "anthropic-version", "value": "2023-06-01"},
                {"name": "content-type", "value": "application/json"}]},
            "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ {model: $env.STACK_CLAUDE_MODEL, max_tokens: %d, thinking: {type: 'disabled'}, system: %s, "
                        "messages: [{role: 'user', content: %s}]} }}" % (max_tokens, json.dumps(system), user_expr)},
    }


def code(name, pos, js, mode="runOnceForEachItem", **extra):
    return {"id": name.lower().replace(" ", "-"), "name": name, "type": "n8n-nodes-base.code", "typeVersion": 2,
            "position": pos, "parameters": {"mode": mode, "jsCode": js}, **extra}


EMAIL_TEXT = "`From: ${$json.from}\\nSubject: ${$json.subject}\\n\\n${$json.body}`"

nodes = [
    {"id": "trigger", "name": "Manual Trigger", "type": "n8n-nodes-base.manualTrigger", "typeVersion": 1,
     "position": [0, 300], "parameters": {}},
    code("Emails", [220, 300], "return %s.map(e => ({json: e}));" % json.dumps(shared.EMAILS), "runOnceForAllItems"),
    claude_node("Classify", [440, 300], shared.CLASSIFY_SYSTEM, EMAIL_TEXT, 200),
    code("Parse", [660, 300], """
const text = $json.content.filter(b => b.type === 'text').map(b => b.text).join('');
const m = text.match(/\\{[\\s\\S]*?\\}/);
const c = m ? JSON.parse(m[0]) : {};
const email = $('Emails').item.json;
return {json: {...email, category: String(c.category || '').toLowerCase(), urgency: String(c.urgency || '').toLowerCase()}};
""".strip()),
    {"id": "route", "name": "Route", "type": "n8n-nodes-base.switch", "typeVersion": 3.2, "position": [880, 300],
     "parameters": {"rules": {"values": [
         {"outputKey": "drop", "conditions": {"options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
          "combinator": "and", "conditions": [{"leftValue": "={{ $json.category }}", "rightValue": "spam",
                                                "operator": {"type": "string", "operation": "equals"}}]}},
         {"outputKey": "escalate", "conditions": {"options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
          "combinator": "and", "conditions": [{"leftValue": "={{ $json.urgency }}", "rightValue": "high",
                                                "operator": {"type": "string", "operation": "equals"}}]}}]},
         "options": {"fallbackOutput": "extra", "renameFallbackOutput": "reply"}}},
    code("Drop", [1100, 120], "const e = $json;\nreturn {json: {id: e.id, subject: e.subject, category: e.category, urgency: e.urgency, action: 'drop'}};"),
    code("Escalate", [1100, 300], "const e = $json;\nreturn {json: {id: e.id, subject: e.subject, category: e.category, urgency: e.urgency, action: 'escalate', escalation: `ESCALATE to on-call team: ${e.subject} (${e.from})`}};"),
    claude_node("Draft", [1100, 480], shared.REPLY_SYSTEM, EMAIL_TEXT, 150),
    code("Reply record", [1320, 480], """
const e = $('Route').item.json;
const reply = $json.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
return {json: {id: e.id, subject: e.subject, category: e.category, urgency: e.urgency, action: 'reply', reply}};
""".strip()),
    {"id": "merge", "name": "Merge", "type": "n8n-nodes-base.merge", "typeVersion": 3, "position": [1540, 300],
     "parameters": {"numberInputs": 3}},
    code("Collect", [1760, 300], """
const results = $input.all().map(i => i.json).sort((a, b) => a.id.localeCompare(b.id));
return [{json: {results}}];
""".strip(), "runOnceForAllItems"),
    {"id": "crm", "name": "Log to CRM", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [1980, 300],
     "retryOnFail": True, "maxTries": 3, "waitBetweenTries": 1000,
     "parameters": {"method": "POST", "url": "http://crm:3000/log", "sendBody": True, "specifyBody": "json",
                    "jsonBody": "={{ {count: $json.results.length} }}"}},
    code("Final", [2200, 300], """
// The CRM service fails its first call, so its answer says how many attempts the retry took.
return [{json: {results: $('Collect').first().json.results, flaky_attempts: $json.attempt}}];
""".strip(), "runOnceForAllItems"),
]

connections = {
    "Manual Trigger": {"main": [[{"node": "Emails", "type": "main", "index": 0}]]},
    "Emails": {"main": [[{"node": "Classify", "type": "main", "index": 0}]]},
    "Classify": {"main": [[{"node": "Parse", "type": "main", "index": 0}]]},
    "Parse": {"main": [[{"node": "Route", "type": "main", "index": 0}]]},
    "Route": {"main": [[{"node": "Drop", "type": "main", "index": 0}],
                       [{"node": "Escalate", "type": "main", "index": 0}],
                       [{"node": "Draft", "type": "main", "index": 0}]]},
    "Draft": {"main": [[{"node": "Reply record", "type": "main", "index": 0}]]},
    "Drop": {"main": [[{"node": "Merge", "type": "main", "index": 0}]]},
    "Escalate": {"main": [[{"node": "Merge", "type": "main", "index": 1}]]},
    "Reply record": {"main": [[{"node": "Merge", "type": "main", "index": 2}]]},
    "Merge": {"main": [[{"node": "Collect", "type": "main", "index": 0}]]},
    "Collect": {"main": [[{"node": "Log to CRM", "type": "main", "index": 0}]]},
    "Log to CRM": {"main": [[{"node": "Final", "type": "main", "index": 0}]]},
}
wf = {"id": "stacktriage0001", "name": "Email triage", "active": False, "nodes": nodes, "connections": connections,
      "settings": {"executionOrder": "v1"}, "versionId": "00000000-0000-0000-0000-000000000001"}
Path(__file__).with_name("workflow.json").write_text(json.dumps(wf, indent=2) + "\n")
print("wrote workflow.json")
