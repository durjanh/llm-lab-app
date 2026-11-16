"""Power Automate: validate flow.definition.json (a cloud flow in Logic Apps workflow language), then SKIP.

A cloud flow only runs in a Power Platform environment with a licence (Microsoft 365 tenant), so this checks that the
export is well formed: schema, trigger, retry policies, branch, loop, wiring between actions, and no literal key.
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))  # examples/stack
sys.path.insert(0, str(HERE.parent))  # automation
from common import checks  # noqa: E402

import shared  # noqa: E402

NAME = "automation/power-automate"
SKIP_WHY = "needs a Power Automate licence (Microsoft 365 tenant); see NOTES.md to import flow.definition.json"


def walk(actions: dict):
    """Every action in a definition, including those nested in If, Foreach and Switch."""
    for name, a in actions.items():
        yield name, a
        yield from walk(a.get("actions", {}))
        yield from walk(a.get("else", {}).get("actions", {}))
        for case in a.get("cases", {}).values():
            yield from walk(case.get("actions", {}))


def validate(text: str) -> list[str]:
    problems = []
    flow = json.loads(text)
    d = flow["properties"]["definition"]
    if "workflowdefinition.json" not in d.get("$schema", ""):
        problems.append("missing workflow definition $schema")
    trig = d.get("triggers", {}).get("manual", {})
    if not (trig.get("type") == "Request" and trig.get("kind") == "Http"):
        problems.append("trigger is not 'When a HTTP request is received'")
    all_actions = dict(walk(d["actions"]))
    types = {a["type"] for a in all_actions.values()}
    for needed in ("Http", "If", "Foreach", "Response"):
        if needed not in types:
            problems.append(f"no {needed} action")
    https = [n for n, a in all_actions.items() if a["type"] == "Http"]
    for n in https:
        if "retryPolicy" not in all_actions[n]["inputs"]:
            problems.append(f"{n} has no retryPolicy")
    # runAfter must name an action that exists beside it.
    def check_scope(actions: dict) -> None:
        for n, a in actions.items():
            for dep in a.get("runAfter", {}):
                if dep not in actions:
                    problems.append(f"{n} runs after missing {dep}")
            for sub in (a.get("actions"), (a.get("else") or {}).get("actions")):
                if sub:
                    check_scope(sub)
    check_scope(d["actions"])
    # Every action named in an expression must exist, and every parameter used must be declared.
    for ref in set(re.findall(r"(?:body|outputs|actions)\('([\w]+)'\)", text)):
        if ref not in all_actions:
            problems.append(f"expression refers to missing action {ref}")
    for ref in set(re.findall(r"parameters\('(\w+)'\)", text)):
        if ref not in d["parameters"]:
            problems.append(f"undeclared parameter {ref}")
    if re.search(r"sk-ant|\"x-api-key\": \"(?!@parameters)", text):
        problems.append("a literal key in the definition")
    if any(json.dumps(p)[1:-1] not in text for p in (shared.CLASSIFY_SYSTEM, shared.REPLY_SYSTEM)):
        problems.append("prompts differ from shared.py (run build_flow.py)")
    return problems


if __name__ == "__main__":
    problems = validate((HERE / "flow.definition.json").read_text())
    if problems:
        checks.report(NAME, False, "; ".join(problems))
    else:
        print("flow.definition.json is well formed: HTTP trigger, Foreach, nested If branch, retry policies, no literal key")
        checks.skip(NAME, SKIP_WHY)
