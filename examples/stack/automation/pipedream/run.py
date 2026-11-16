"""Pipedream: POST the emails to the workflow's HTTP trigger when PIPEDREAM_WEBHOOK_URL is set; else run the step code locally.

Local run: node executes triage.js and log_to_crm.js with a fake `$` (real Claude calls). That proves the code works.
The hosted Pipedream workflow is NOT run in that case, and the result line says so.
"""
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))  # examples/stack
sys.path.insert(0, str(HERE.parent))  # automation
from common import checks, config  # noqa: E402

import shared  # noqa: E402

NAME = "automation/pipedream"


def sync_emails() -> None:
    (HERE / "emails.js").write_text("// The five invented emails (written from ../shared.py by run.py, so both stay in step).\n"
                                    f"export const shared = {json.dumps(shared.EMAILS, indent=2)};\n")


def hosted(url: str) -> None:
    req = urllib.request.Request(url, json.dumps({"emails": shared.EMAILS}).encode(), {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        body = json.load(r)
    ok, detail = shared.check(body["results"], body["flaky_attempts"])
    print("results:", shared.write_results(shared.output_dir("pipedream"), body["results"], body["flaky_attempts"]))
    checks.report(NAME, ok, detail + " (hosted Pipedream workflow)")


def local() -> None:
    sync_emails()
    triage = (HERE / "triage.js").read_text()
    if any(json.dumps(p) not in triage for p in (shared.CLASSIFY_SYSTEM, shared.REPLY_SYSTEM)):
        checks.report(NAME, False, "triage.js prompts differ from shared.py")
        return
    if not (HERE / "node_modules" / "@anthropic-ai" / "sdk").exists():
        subprocess.run(["npm", "install", "--no-audit", "--no-fund", "--silent"], cwd=HERE, check=True)
    out = shared.output_dir("pipedream")
    env = {**os.environ, "ANTHROPIC_API_KEY": config.env("ANTHROPIC_API_KEY"), "STACK_OUT": str(out)}
    run = subprocess.run(["node", "local.js"], cwd=HERE, env=env, capture_output=True, text=True, timeout=300)
    print(run.stdout.replace(config.env("ANTHROPIC_API_KEY"), "***")[-1500:])
    line = next((ln for ln in run.stdout.splitlines() if ln.startswith("RESPONSE ")), None)
    if not line:
        print(run.stderr[-1500:])
        checks.report(NAME, False, "local run produced no response")
        return
    body = json.loads(line[len("RESPONSE "):])
    ok, detail = shared.check(body["results"], body["flaky_attempts"])
    checks.report(NAME, ok, detail + " (local node run; hosted Pipedream workflow not run)")


if __name__ == "__main__":
    url = config.env("PIPEDREAM_WEBHOOK_URL")
    if url:
        hosted(url)
    elif not shared.need_key():
        checks.skip(NAME, "set ANTHROPIC_API_KEY (local run) or PIPEDREAM_WEBHOOK_URL (hosted run)")
    else:
        local()
