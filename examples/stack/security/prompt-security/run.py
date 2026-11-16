"""Prompt Security: skips unless you have a tenant. Prompt Security is a commercial platform with no self-serve SDK.

If PS_PROTECT_URL (https://<region>.prompt.security/api/protect) and PS_APP_ID (from the tenant's admin portal) are set,
this calls the Protect API with the request shape that NVIDIA's NeMo Guardrails integration uses, and scores the shared
test set. That shape comes from NeMo's open-source client, not from public Prompt Security documentation, which we could
not find. Without them it skips and says why.
"""
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE.parent))
from common import checks, config  # noqa: E402
import shared  # noqa: E402

NAME = "security/prompt-security"


def protect(url: str, app_id: str, prompt: str) -> str:
    """The action Prompt Security answers with: "log", "block" or "modify" (as read by NeMo Guardrails' client)."""
    body = json.dumps({"prompt": prompt, "system_prompt": None, "response": None, "user": None}).encode()
    req = urllib.request.Request(url, data=body, headers={"APP-ID": app_id, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get("result", {}).get("action", "log")


def main() -> None:
    url, app_id = config.env("PS_PROTECT_URL"), config.env("PS_APP_ID")
    if not (url and app_id):
        return checks.skip(NAME, "commercial platform with no public self-serve SDK or free tier: needs a Prompt Security "
                                 "tenant (set PS_PROTECT_URL and PS_APP_ID); see NOTES.md")
    scores, notes = shared.evaluate_injection(
        lambda prompt, doc: protect(url, app_id, prompt if not doc else f"{prompt}\n\n{doc}") == "block")
    for n in notes:
        print(" ", n)
    ok = scores["detection"] >= 0.8 and scores["false_positive"] <= 0.1
    checks.report(NAME, ok, shared.fmt(scores))


if __name__ == "__main__":
    main()
