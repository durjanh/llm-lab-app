"""Closed-deal agents: the similarity score, thresholds and email rules in code, then a whole run through the API with
a scripted model that breaks a rule once. No network, no cost."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services import deals
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB

WIN = {"why_won": "Store-and-day forecasts cut fresh waste in the pilot.", "pains": ["fresh food waste", "weekly regional forecasts"],
       "trigger": "A board target to cut waste by a quarter.",
       "proof_point": "A regional grocer with about 40 stores cut fresh food waste by 31% in a 10-week pilot."}


def ratings(need_by_id: dict[str, tuple[int, int]]) -> dict:
    return {"accounts": [{"account_id": i, "need": n, "timing": t, "angle": f"Store-and-day forecasts for {i}.",
                          "reason": "From the notes."} for i, (n, t) in need_by_id.items()]}


def email(body: str = "Hi there,\n\nA regional grocer cut fresh food waste by 31%. Could we talk for 20 minutes?\n\nThe Larkfield team") -> dict:
    return {"subject": "Cutting fresh food waste", "body": body}


def app(tmp_path: Path, script: list[dict]) -> tuple[TestClient, ScriptedClient]:
    fake = ScriptedClient([[text(json.dumps(reply))] for reply in script])
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models", heartbeat_s=0.2)
    return TestClient(create_app(settings, client=fake), base_url="http://localhost:8000"), fake


def run(client: TestClient, deal: str = "D01") -> list[dict]:
    with client.stream("POST", f"/api/deals/{deal}/close", json={}, headers=LAB) as r:
        return [json.loads(line) for line in r.iter_lines() if line.strip()]


def test_similarity_is_worked_out_by_code() -> None:
    won = {"industry": "grocery retail", "employees": 2400, "region": "North West", "tech": "SAP,Snowflake,Power BI"}
    twin = {**won, "employees": 1900, "tech": "SAP,Snowflake,Tableau", "current_vendor": "Brightcast"}
    sim = deals.similarity(won, twin, "Brightcast")
    assert sim["score"] == 40 + 20 + 15 + 10 + 10 and sim["shared_systems"] == ["SAP", "Snowflake"]
    other = {"industry": "logistics", "employees": 100, "region": "Midlands", "tech": "Oracle", "current_vendor": ""}
    assert deals.similarity(won, other, "Brightcast")["score"] == 0


def test_the_thresholds_decide_the_priority_not_the_model() -> None:
    assert deals.priority(90, 9, 8) == {"combined": 88, "priority": "A"}
    assert deals.priority(60, 5, 5) == {"combined": 55, "priority": "B"}
    assert deals.priority(40, 2, 1)["priority"] == "skip"


def test_a_draft_that_names_the_won_customer_is_caught() -> None:
    names = deals.banned_names({"name": "Harrow & Vale Grocers", "aliases": "Harrow and Vale,Harrow & Vale"},
                               [{"name": "Priya Raman"}])
    assert deals.draft_problems("Hello", "A regional grocer cut waste by 31%.", names) == []
    for bad in ("As HARROW & VALE found", "harrow  and vale saw", "Ask Priya Raman about it"):
        assert deals.draft_problems("Hello", bad, names), bad
    assert deals.draft_problems("Hello", "word " * 200, names)
    assert "Harrow" not in deals.redact("Harrow & Vale Grocers cut waste; Priya Raman agreed.", names)


def test_a_whole_run_through_the_api(tmp_path: Path) -> None:
    leaky = {**WIN, "proof_point": "Harrow & Vale Grocers cut fresh food waste by 31%."}
    rated = ratings({"A02": (9, 9), "A03": (8, 8), "A05": (8, 7), "A08": (5, 2), "A12": (6, 6), "A10": (3, 2), "ZZ9": (10, 10)})
    # win (names the customer), win again, classify, then one email per account with a contact: A02 (bad then good), A03
    client, fake = app(tmp_path, [leaky, WIN, rated, email("Like Harrow & Vale, you could cut waste."), email(), email()])
    info = client.get("/api/deals/info", headers=LAB).json()
    assert [s["id"] for s in info["steps"]][0] == "trigger" and info["daily_cap"] == deals.DAILY_CAP

    events = run(client)
    assert events[0]["type"] == "run" and events[-1]["type"] == "done", events[-1]
    steps = {e["step"]: e for e in events if e["type"] == "step" and e["status"] == "done"}
    assert list(steps) == ["trigger", "win", "finder", "competitor", "classify", "enrich", "email"]
    assert steps["win"]["detail"]["names_removed_by_code"] and "Harrow" not in steps["win"]["detail"]["proof_point"]
    found = [c["account_id"] for c in steps["finder"]["detail"]]
    assert "A01" not in found and "A13" not in found and "A14" not in found  # the won one, a customer, a deal in progress
    assert found[0] == "A02" and len(found) <= deals.MAX_CANDIDATES
    rows = {c["account_id"]: c for c in steps["classify"]["detail"]}
    assert "ZZ9" not in rows and rows["A02"]["priority"] == "A" and rows["A10"]["priority"] != "A"
    # Kestrel (A05) is priority A, but its only contacts have not agreed or have unsubscribed: nothing is drafted
    assert rows["A05"]["priority"] == "A"
    contacts = {c["account"]: c for c in steps["enrich"]["detail"]["contacts"]}
    assert contacts["Kestrel Pharmacy Group"]["ok"] is False
    assert contacts["Castlegate Foods"]["contact"] == "Aoife Brennan"  # the COO is more senior but has not agreed
    assert "Harrow" in fake.calls[1][1]["messages"][0]["content"] and "cannot be used" in fake.calls[4][1]["messages"][0]["content"]

    state = events[-1]
    assert state["deals"][0]["stage"] == "closed_won" and events[-1]["drafts"] == 2
    by_account = {o["account"]: o for o in state["outreach"]}
    assert by_account["Kestrel Pharmacy Group"]["status"] == "blocked"
    draft = by_account["Pennine Fresh Markets"]
    assert draft["status"] == "draft" and "second try" in draft["reason"] and draft["body"].endswith(deals.FOOTER)
    assert all("Harrow" not in o["body"] for o in state["outreach"])
    assert client.post("/api/deals/D01/close", json={}, headers=LAB).status_code == 409  # already closed

    # consent withdrawn after drafting: approval is refused and nothing is sent
    client.post("/api/deals/contacts/C03/consent", json={"consent": False}, headers=LAB)
    refused = client.post(f"/api/deals/outreach/{draft['id']}/decision", json={"approve": True}, headers=LAB)
    assert refused.status_code == 409 and "agreed" in refused.json()["error"]["message"]
    other = by_account["Castlegate Foods"]
    sent = client.post(f"/api/deals/outreach/{other['id']}/decision", json={"approve": True}, headers=LAB).json()
    assert sent["sent"] and sent["cap"] == {"limit": deals.DAILY_CAP, "sent_today": 1, "left": deals.DAILY_CAP - 1}
    assert client.post(f"/api/deals/outreach/{other['id']}/decision", json={"approve": False}, headers=LAB).status_code == 409
    assert len(fake.calls) == 6  # approving and rejecting make no model call

    fresh = client.post("/api/deals/reset", headers=LAB).json()
    assert fresh["outreach"] == [] and fresh["deals"][0]["stage"] == "open"


def test_the_daily_cap_stops_the_next_send(tmp_path: Path) -> None:
    client, _ = app(tmp_path, [WIN, ratings({"A02": (9, 9), "A03": (9, 9), "A08": (9, 9), "A12": (9, 9)}),
                                email(), email(), email(), email()])
    done = run(client)[-1]
    drafts = [o for o in done["outreach"] if o["status"] == "draft"]
    assert len(drafts) == 4 > deals.DAILY_CAP
    answers = [client.post(f"/api/deals/outreach/{d['id']}/decision", json={"approve": True}, headers=LAB) for d in drafts]
    assert [a.status_code for a in answers] == [200] * deals.DAILY_CAP + [409]
    assert "limit" in answers[-1].json()["error"]["message"]
    kept = client.get("/api/deals/state", headers=LAB).json()
    assert kept["cap"]["left"] == 0 and sum(o["status"] == "draft" for o in kept["outreach"]) == 1  # kept for tomorrow
    db = sqlite3.connect(tmp_path / "deals" / "crm.db")
    assert db.execute("SELECT COUNT(*) FROM outreach WHERE status = 'sent'").fetchone()[0] == deals.DAILY_CAP


def test_a_rejected_draft_is_never_sent(tmp_path: Path) -> None:
    client, _ = app(tmp_path, [WIN, ratings({"A02": (9, 9)}), email()])
    done = run(client)[-1]
    draft = next(o for o in done["outreach"] if o["status"] == "draft")
    out = client.post(f"/api/deals/outreach/{draft['id']}/decision", json={"approve": False}, headers=LAB).json()
    assert out["sent"] is False and out["cap"]["sent_today"] == 0 and out["outreach"][0]["status"] == "rejected"
