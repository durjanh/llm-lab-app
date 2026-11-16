"""Make: POST the five emails to the scenario's webhook when MAKE_WEBHOOK_URL is set, else validate the blueprint and SKIP.

Each webhook call is one email and the scenario's Webhook response module answers with its outcome as a form-encoded
body, so the answers can be checked here. The flaky CRM step is not part of the hosted scenario (Make cannot reach a
local flaky server), so the retry is configured (Break directive) but not exercised.
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))  # examples/stack
sys.path.insert(0, str(HERE.parent))  # automation
from common import checks, config  # noqa: E402

import shared  # noqa: E402

NAME = "automation/make"
SETUP = ("set MAKE_WEBHOOK_URL: in Make choose Create scenario > ... > Import Blueprint (blueprint.json), "
         "create the webhook in module 1, paste your Anthropic key into the two HTTP modules, set the scenario "
         "to run immediately, and copy the webhook address")


def modules(flow: list):
    for m in flow:
        yield m
        for route in m.get("routes", []):
            yield from modules(route["flow"])


def validate(bp: dict) -> list[str]:
    problems = []
    mods = list(modules(bp["flow"]))
    ids = [m["id"] for m in mods] + [h["id"] for m in mods for h in m.get("onerror", [])]
    if len(ids) != len(set(ids)):
        problems.append("duplicate module ids")
    kinds = [m["module"] for m in mods]
    for need in ("gateway:CustomWebHook", "http:ActionSendData", "builtin:BasicRouter", "gateway:WebhookRespond"):
        if need not in kinds:
            problems.append(f"no {need} module")
    https = [m for m in mods if m["module"] == "http:ActionSendData"]
    if not https or not all(m.get("onerror") for m in https):
        problems.append("an HTTP module has no error handler (retry)")
    text = json.dumps(bp)
    if "sk-ant" in text:
        problems.append("a literal key in the blueprint")
    sent = {json.loads(m["mapper"]["data"])["system"] for m in https}
    if sent != {shared.CLASSIFY_SYSTEM, shared.REPLY_SYSTEM}:
        problems.append("prompts differ from shared.py (run build_blueprint.py)")
    return problems


def hosted(url: str) -> None:
    results = []
    for e in shared.EMAILS:
        req = urllib.request.Request(url, json.dumps(e).encode(), {"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            answer = {k: v[0] for k, v in urllib.parse.parse_qs(r.read().decode()).items()}
        answer["subject"] = e["subject"]
        results.append(answer)
    ok, detail = shared.check(results, 0, need_retry=False)
    print("results:", shared.write_results(shared.output_dir("make"), results, 0))
    checks.report(NAME, ok, detail)


if __name__ == "__main__":
    url = config.env("MAKE_WEBHOOK_URL")
    if url:
        hosted(url)
    else:
        problems = validate(json.loads((HERE / "blueprint.json").read_text()))
        if problems:
            checks.report(NAME, False, "; ".join(problems))
        else:
            print("blueprint.json is well formed: webhook, two HTTP modules with Break retry, router with three routes, responses")
            checks.skip(NAME, SETUP)
