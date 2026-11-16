"""Lakera Guard API on the shared security test set. Needs LAKERA_GUARD_API_KEY; skips without it.

Lakera Guard v2: POST https://api.lakera.ai/v2/guard with {"messages": [...], "breakdown": true}. The reply has
`flagged` and, with breakdown, a list of detectors (prompt_attack, pii/*, moderated_content/*, unknown_links).
Indirect attacks go in as a second message from the user with the retrieved text, since Guard screens the whole
conversation; the reply says which detector fired.
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE.parent))
from common import checks, config  # noqa: E402
import shared  # noqa: E402

NAME = "security/lakera"
URL = os.environ.get("LAKERA_GUARD_URL", "https://api.lakera.ai/v2/guard")


def guard(session, messages: list[dict], key: str) -> dict:
    r = session.post(URL, json={"messages": messages, "breakdown": True, "payload": True},
                     headers={"Authorization": f"Bearer {key}"}, timeout=30)
    r.raise_for_status()
    return r.json()


def prompt_attack(result: dict) -> bool:
    """True when the prompt_attack detector fired (not just any flag, so PII or moderation does not count)."""
    return any(d.get("detector_type", "").startswith("prompt_attack") and d.get("detected")
               for d in result.get("breakdown", []))


def main() -> None:
    key = config.env("LAKERA_GUARD_API_KEY")
    import requests

    session = requests.Session()
    if not key:
        # Build the request without sending it, so the code path is checked.
        req = requests.Request("POST", URL, json={"messages": [{"role": "user", "content": shared.ATTACKS[0].text()}],
                                                  "breakdown": True, "payload": True}, headers={"Authorization": "Bearer <key>"}).prepare()
        assert req.body and req.url == URL
        return checks.skip(NAME, "set LAKERA_GUARD_API_KEY (free key at platform.lakera.ai) to call Lakera Guard")

    def classify(prompt: str, document: str) -> bool:
        msgs = [{"role": "user", "content": prompt}]
        if document:
            msgs.append({"role": "user", "content": document})
        return prompt_attack(guard(session, msgs, key))

    scores, notes = shared.evaluate_injection(classify)
    for n in notes:
        print(" ", n)
    # PII: Lakera reports "detected" per pii detector; with a breakdown it also gives matched text in `payload`.
    results = {}
    for case in shared.PII_CASES:
        out = guard(session, [{"role": "user", "content": case.text}], key)
        spans = [p.get("text", "") for p in out.get("payload", []) if p.get("detector_type", "").startswith("pii")]
        results[case.id] = (spans, case.text)
    pii = shared.pii_score(results)
    print(f"  PII: {pii.found}/{pii.total} found")
    ok = scores["detection"] >= 0.8 and scores["false_positive"] <= 0.1
    checks.report(NAME, ok, f"{shared.fmt(scores)}; PII {pii.found}/{pii.total} found")


if __name__ == "__main__":
    main()
