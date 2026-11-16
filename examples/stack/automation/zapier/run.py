"""Zapier: POST the five emails to the Zap's Catch Hook when ZAPIER_WEBHOOK_URL is set, else dry-run and SKIP.

A Zap runs once per event and a Catch Hook answers straight away, so results are read in Zap history, not here.
Without a URL this still checks that both Code by Zapier steps run: a stub `requests` stands in for the Anthropic API.
"""
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))  # examples/stack
sys.path.insert(0, str(HERE.parent))  # automation
from common import checks, config  # noqa: E402

import shared  # noqa: E402

NAME = "automation/zapier"
SETUP = ("set ZAPIER_WEBHOOK_URL: in Zapier create the Zap in ZAP.md (Catch Hook, two Code by Zapier Python steps "
         "from code_step_*.py, Paths, Webhooks POST), turn it on, copy the Catch Hook URL")


class Stub:
    """Stands in for `requests` and the Anthropic API: answers by the system prompt, like the real model would."""

    class Response:
        def __init__(self, text: str) -> None:
            self.text = text

        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict:
            return {"content": [{"type": "text", "text": self.text}]}

    def post(self, url, headers, json, timeout):
        assert url.startswith("https://api.anthropic.com/") and headers["x-api-key"] and json["messages"]
        user = json["messages"][0]["content"]
        if json["system"].startswith("You triage"):
            if "newborn" in user:
                return self.Response('{"category": "emergency", "urgency": "high"}')
            if "WON" in user:
                return self.Response('{"category": "spam", "urgency": "low"}')
            return self.Response('{"category": "question", "urgency": "normal"}')
        return self.Response("Thanks for getting in touch. We will reply shortly.")


def run_step(file: str, input_data: dict) -> dict:
    scope = {"input_data": input_data, "requests": Stub()}
    exec(compile((HERE / file).read_text(), file, "exec"), scope)
    return scope["output"]


def dry_run() -> str:
    routes = {}
    for e in shared.EMAILS:
        data = {"api_key": "dry-run", "model": shared.MODEL, "from": e["from"], "subject": e["subject"], "body": e["body"]}
        out = run_step("code_step_classify.py", data)
        routes[e["id"]] = out["route"]
        if out["route"] == "reply":
            assert run_step("code_step_draft.py", data)["reply"]
    assert routes["e1"] == "escalate" and routes["e4"] == "drop", routes
    return "both Code steps run against a stub: e1 escalates, e4 drops, the rest draft"


if __name__ == "__main__":
    url = config.env("ZAPIER_WEBHOOK_URL")
    if not url:
        print(dry_run())
        checks.skip(NAME, SETUP)
    else:
        for e in shared.EMAILS:
            req = urllib.request.Request(url, json.dumps(e).encode(), {"content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                assert r.status == 200
        checks.report(NAME, True, f"{len(shared.EMAILS)} emails accepted by the Catch Hook; read the outcomes in Zap history (not checked here)")
