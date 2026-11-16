"""The one small AI workflow every automation tool runs: triage five invented customer emails.

Standard library only, so any tool's virtual environment can import it.

    1. classify   Claude returns {"category", "urgency"} as JSON for each email
    2. branch     urgency high      -> an "escalation" record (no model call)
                  category spam     -> dropped
                  anything else     -> Claude drafts a short reply
    3. save       every record goes to results.json in an output folder
    4. flaky step "log to CRM" fails the first time it is called, to show each tool's retry handling

The tool's job is to orchestrate. `claude()` here is the plain Messages API call the code-first tools use; the
low-code tools make the same call from their own HTTP node.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack
from common import config  # noqa: E402  (loads the lab's .env without printing it)

MODEL = config.CLAUDE_MODEL
API_URL = "https://api.anthropic.com/v1/messages"

EMAILS = [
    {"id": "e1", "from": "mara.quinn@example.com", "subject": "Boiler broken, newborn baby",
     "body": "Our boiler stopped working this morning and the house is freezing. We have a six-day-old baby at "
             "home and no other heating. Please can an engineer come today?"},
    {"id": "e2", "from": "tomas.reid@example.com", "subject": "Refund for order 4471",
     "body": "I would like a refund for order 4471. The kettle arrived last week and I have not opened the box. "
             "Please tell me how to send it back."},
    {"id": "e3", "from": "ines.park@example.com", "subject": "Carrying over annual leave",
     "body": "Quick question: how many unused days of annual leave can I carry into next year?"},
    {"id": "e4", "from": "promo@win-big-now.example", "subject": "YOU HAVE WON 1,000,000 POUNDS",
     "body": "Click here now to claim your prize. Send your bank details to claim. Limited offer, act fast!!!"},
    {"id": "e5", "from": "gareth.lowe@example.com", "subject": "Disappointed with my last visit",
     "body": "The engineer was forty minutes late last Tuesday and did not apologise. The repair was fine, but I "
             "expected better service. I would like someone to look into it."},
]

FAQ = "Annual leave: you can carry up to 5 unused days into the next year; the rest are lost on 31 March."

CATEGORIES = ["emergency", "refund", "question", "complaint", "spam"]
CLASSIFY_SYSTEM = (
    "You triage customer emails. Reply with JSON only, no other text: "
    '{"category": "emergency|refund|question|complaint|spam", "urgency": "high|normal|low"}. '
    "urgency is high only when someone's health or safety is at risk (for example no heating with a baby). "
    "Refunds, ordinary questions and complaints about service are normal or low. Spam is low."
)
REPLY_SYSTEM = (
    "You write short, polite customer replies, three sentences at most, in plain British English. "
    "Use only the facts in the email and the FAQ. Do not invent policies. FAQ: " + FAQ
)

# What a correct run produces.
EXPECTED = {"e1": "escalate", "e2": "reply", "e3": "reply", "e4": "drop", "e5": "reply"}


def email_text(e: dict) -> str:
    return f"From: {e['from']}\nSubject: {e['subject']}\n\n{e['body']}"


def claude(system: str, user: str, max_tokens: int = 200) -> str:
    """One Messages API call with the key from the environment; returns the reply text."""
    key = config.env("ANTHROPIC_API_KEY")
    body = json.dumps({"model": MODEL, "max_tokens": max_tokens, "thinking": {"type": "disabled"}, "system": system,
                       "messages": [{"role": "user", "content": user}]}).encode()
    req = urllib.request.Request(API_URL, body, {"x-api-key": key, "anthropic-version": "2023-06-01",
                                                 "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    return "".join(b.get("text", "") for b in data["content"] if b.get("type") == "text")


def parse_json(text: str) -> dict:
    """The first JSON object in a model reply (models sometimes wrap it in a code fence)."""
    m = re.search(r"\{.*?\}", text, re.S)
    return json.loads(m.group(0)) if m else {}


def classify(email: dict) -> dict:
    c = parse_json(claude(CLASSIFY_SYSTEM, email_text(email)))
    return {"category": str(c.get("category", "")).lower(), "urgency": str(c.get("urgency", "")).lower()}


def route(c: dict) -> str:
    """The branch: escalate, drop or reply."""
    if c.get("category") == "spam":
        return "drop"
    if c.get("urgency") == "high":
        return "escalate"
    return "reply"


def draft_reply(email: dict) -> str:
    return claude(REPLY_SYSTEM, email_text(email), 150).strip()


def record(email: dict, c: dict, action: str, reply: str = "") -> dict:
    """The result record every tool writes for one email."""
    r = {"id": email["id"], "subject": email["subject"], "category": c.get("category"),
         "urgency": c.get("urgency"), "action": action}
    if action == "escalate":
        r["escalation"] = f"ESCALATE to on-call team: {email['subject']} ({email['from']})"
    if action == "reply":
        r["reply"] = reply
    return r


class FlakyCrm:
    """The deliberately flaky step: raises on the first call, works from the second. Counts its calls."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, results: list[dict]) -> int:
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("CRM unavailable (deliberate first-call failure)")
        return len(results)


def run_reference() -> tuple[list[dict], int]:
    """The workflow as plain Python with a hand-written retry; the tools are compared with this."""
    results = []
    for e in EMAILS:
        c = classify(e)
        a = route(c)
        results.append(record(e, c, a, draft_reply(e) if a == "reply" else ""))
    crm = FlakyCrm()
    for _ in range(3):
        try:
            crm(results)
            break
        except RuntimeError:
            pass
    return results, crm.calls


def output_dir(name: str) -> Path:
    """A fresh output folder under the system temp directory for one tool's run."""
    import tempfile
    d = Path(tempfile.mkdtemp(prefix=f"stack-automation-{name}-"))
    return d


def write_results(folder: Path, results: list[dict], flaky_attempts: int) -> Path:
    path = Path(folder) / "results.json"
    path.write_text(json.dumps({"results": results, "flaky_attempts": flaky_attempts}, indent=2))
    return path


def check(results: list[dict], flaky_attempts: int, need_retry: bool = True) -> tuple[bool, str]:
    """True when: the urgent email escalated, spam dropped, three drafts, and the flaky step needed a retry.

    Hosted tools cannot be given a flaky endpoint they can reach, so they pass need_retry=False and say so.
    """
    by_id = {r.get("id"): r for r in results}
    problems = []
    for eid, want in EXPECTED.items():
        got = by_id.get(eid, {}).get("action")
        if got != want:
            problems.append(f"{eid} {got!r} not {want!r}")
    drafts = [r for r in results if r.get("action") == "reply" and len(r.get("reply", "").strip()) > 10]
    if len(drafts) != 3:
        problems.append(f"{len(drafts)} drafts, want 3")
    if "escalation" not in by_id.get("e1", {}):
        problems.append("e1 has no escalation record")
    if need_retry and flaky_attempts < 2:
        problems.append(f"flaky step ran {flaky_attempts}x, no retry seen")
    if problems:
        return False, "; ".join(problems)
    tail = f"flaky step retried ({flaky_attempts} attempts)" if need_retry else "retry not exercised"
    return True, f"e1 escalated, e4 dropped, {len(drafts)} drafts, {tail}"


def need_key() -> bool:
    return bool(config.env("ANTHROPIC_API_KEY"))


if __name__ == "__main__":
    res, n = run_reference()
    print(check(res, n))
