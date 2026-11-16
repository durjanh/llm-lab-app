"""Helicone as a gateway: Anthropic calls go through Helicone's proxy with an auth header and custom properties.

Needs HELICONE_API_KEY. Without it the script still builds the client and checks the headers it would send.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
from common import checks, config  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # observability
import shared  # noqa: E402

NAME = "observability/helicone"
GATEWAY = "https://anthropic.helicone.ai"  # Helicone's Anthropic proxy; self-hosting is described in NOTES.md
API = "https://api.helicone.ai/v1/request/query"


def make_client(helicone_key: str):
    import anthropic
    return anthropic.Anthropic(base_url=GATEWAY, default_headers={
        "Helicone-Auth": f"Bearer {helicone_key}",
        "Helicone-Property-App": "stack-observability",
        "Helicone-Property-Area": "northwind-rag",
    })


def main() -> None:
    key = config.env("HELICONE_API_KEY")
    if not config.HAS_CLAUDE:
        return checks.skip(NAME, "set ANTHROPIC_API_KEY")
    if not key:
        client = make_client("dummy")  # builds the client only: nothing is sent
        assert str(client.base_url).startswith(GATEWAY) and "Helicone-Auth" in client.default_headers
        return checks.skip(NAME, "set HELICONE_API_KEY to route the six questions through Helicone (client and headers build fine)")
    import requests
    client = make_client(key)
    ids = []
    for g in shared.QUESTIONS:
        contexts = shared.retrieve(g.question)
        raw = client.messages.with_raw_response.create(
            model=shared.MODEL, max_tokens=150, system=shared.SYSTEM,
            messages=[{"role": "user", "content": shared.user_prompt(g.question, contexts)}],
            extra_headers={"Helicone-Property-Question": g.section, "Helicone-Session-Name": "stack-observability"})
        ids.append(raw.headers.get("helicone-id"))
    # Read the requests back by property.
    found = 0
    for _ in range(12):
        r = requests.post(API, headers={"Authorization": f"Bearer {key}"}, timeout=30, json={
            "filter": {"request_response_rmt": {"properties": {"App": {"equals": "stack-observability"}}}}, "limit": 50})
        rows = r.json().get("data", []) if r.ok else []
        found = len({row.get("request_id") for row in rows} & set(ids))
        if found >= len(ids):
            break
        time.sleep(5)
    checks.report(NAME, found == len(ids), f"{found}/{len(ids)} requests read back from Helicone by custom property")


if __name__ == "__main__":
    main()
