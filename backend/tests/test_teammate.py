"""Digital teammate: the supplier rules and sums in code, the checks on a reply, the admin's controls and the audit log,
then whole answers through the API with a scripted model. No network, no cost."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services import teammate as tm
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text, use
from backend.tests.test_api import LAB

TODAY = date(2026, 11, 18)
ASK = f"{tm.MENTION} we're 18 batches short. Who should we shortlist?"

READ_ALL = [use("read_demand_plan", {}, 1), use("list_suppliers", {}, 2),
            use("read_quality_record", {"supplier_id": "S1"}, 3), use("read_quality_record", {"supplier_id": "S4"}, 4),
            use("read_contract", {"supplier_id": "S1"}, 5), use("read_contract", {"supplier_id": "S4"}, 6)]
CHECK = [use("check_coverage", {"allocations": [{"supplier_id": "S1", "batches": 14},
                                                {"supplier_id": "S4", "batches": 4}]}, 7)]
GOOD = {"summary": "Shortlist Brackenridge for 14 batches and Vantage for 4. Together they cover the 18-batch gap for "
                   "£77,200. Vantage still needs its first-article inspection.",
        "shortlist": [{"supplier_id": "S1", "batches": 14, "why": "Most capacity that passes the rules."},
                      {"supplier_id": "S4", "batches": 4, "why": "Best quality record, 3-week lead time."}],
        "citations": ["DOC-01", "DOC-10", "DOC-21", "DOC-24"]}


def post(reply: dict, i: int = 9) -> list[dict]:
    return [use("post_reply", reply, i)]


def app(tmp_path: Path, script: list[Any]) -> tuple[TestClient, ScriptedClient]:
    fake = ScriptedClient(script)
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models", heartbeat_s=0.2)
    application = create_app(settings, client=fake)
    application.state.container.teammate.today = lambda: TODAY
    return TestClient(application, base_url="http://localhost:8000"), fake


def stream(client: TestClient, path: str, words: str) -> list[dict]:
    with client.stream("POST", path, json={"text": words}, headers=LAB) as r:
        assert r.status_code == 200, r.read()
        return [json.loads(line) for line in r.iter_lines() if line.strip()]


def model_calls(fake: ScriptedClient) -> list[dict]:
    return [p for name, p in fake.calls if name == "messages.create"]


# ----- the rules and sums in code -----

def test_the_supplier_rules_are_code() -> None:
    assert tm.quality_check("S1", TODAY) == {"passes": True, "fails": []}
    hartley = tm.quality_check("S3", TODAY)
    assert not hartley["passes"] and len(hartley["fails"]) == 4  # lapsed certificate, defects, on time, lead time
    assert not tm.quality_check("S1", date(2027, 9, 1))["passes"]  # its certificate lapses on 31 August 2027


def test_coverage_is_worked_out_by_code() -> None:
    cov = tm.coverage([{"supplier_id": "S1", "batches": 14}, {"supplier_id": "S4", "batches": 4}], None, TODAY)
    assert (cov["covered"], cov["gap_left"], cov["cost_gbp"]) == (30, 0, 14 * 4200 + 4 * 4600)
    over = tm.coverage([{"supplier_id": "S2", "batches": 25}, {"supplier_id": "ZZ", "batches": 1}], 20, TODAY)
    assert over["over_by"] == 15 and len(over["problems"]) == 2 and over["rows"][0]["single_site"]


def test_numbers_match_however_they_are_written() -> None:
    assert tm.numbers_in("£4,200 and 96% on 2026-11-20, 0.50 of it") == {"4200", "96", "2026", "11", "20", "0.5"}


# ----- whole answers through the API -----

def test_an_answer_with_a_reply_code_sends_back_once(tmp_path: Path) -> None:
    bad = {**GOOD, "summary": "Give Hartley the whole gap and save £25,000.",
           "shortlist": [{"supplier_id": "S3", "batches": 20, "why": "Cheapest."}], "citations": ["DOC-33"]}
    client, fake = app(tmp_path, [READ_ALL, CHECK, post(bad, 8), post(GOOD)])
    events = stream(client, "/api/teammate/posts", ASK)
    assert events[-1]["type"] == "done", events[-1]
    labels = [e["label"] for e in events if e["type"] == "step" and e["status"] != "running"]
    assert "Read the quality record: Brackenridge Plastics" in labels and "Reply sent back (code)" in labels

    sent_back = model_calls(fake)[3]["messages"][-1]["content"][0]
    assert sent_back["is_error"] and "not read its quality record" in sent_back["content"]
    assert "DOC-33" in sent_back["content"] and "25000" in sent_back["content"] and "gap is 18" in sent_back["content"]

    thread = events[-1]["threads"][0]
    agent = thread["messages"][-1]
    assert agent["role"] == "agent" and agent["author"] == tm.AGENT_NAME
    assert agent["data"]["coverage"]["gap_left"] == 0 and agent["data"]["coverage"]["cost_gbp"] == 77200
    assert {c["owner"] for c in agent["data"]["checklist"]} == {"Grace Whitfield", "Tom Kerr"}
    log = events[-1]["audit"]
    assert sum(a["kind"] == "tool" and a["actor"] == tm.AGENT_NAME for a in log) == 7
    assert any(a["outcome"] == "sent back" for a in log)


def test_a_withdrawn_scope_is_refused_at_the_tool_call(tmp_path: Path) -> None:
    honest = {"summary": "I could not read the quality records, so I cannot shortlist anyone yet.", "shortlist": [],
              "citations": ["DOC-01"]}
    client, fake = app(tmp_path, [[use("read_demand_plan", {}, 1), use("read_quality_record", {"supplier_id": "S1"}, 2)],
                                  post({**GOOD, "citations": ["DOC-01"]}, 3), post(honest, 4)])
    client.post("/api/teammate/admin", json={"scopes": ["demand", "suppliers", "contracts"]}, headers=LAB)
    events = stream(client, "/api/teammate/posts", ASK)
    assert events[-1]["type"] == "done", events[-1]
    result = model_calls(fake)[1]["messages"][-1]["content"][1]
    assert result["is_error"] and "Access denied" in result["content"]
    assert "not read its quality record" in model_calls(fake)[2]["messages"][-1]["content"][0]["content"]
    agent = events[-1]["threads"][0]["messages"][-1]
    assert agent["data"]["not_checked"] == ["Quality records"] and agent["data"]["shortlist"] == []
    log = events[-1]["audit"]
    assert any(a["outcome"].startswith("denied") and a["name"] == "read_quality_record" for a in log)
    assert any(a["actor"] == "Admin (you)" and "withdrew Quality records" in a["detail"] for a in log)


def test_turned_off_or_not_mentioned_means_no_model_call(tmp_path: Path) -> None:
    client, fake = app(tmp_path, [])
    quiet = stream(client, "/api/teammate/posts", "Morning all, the PX-40 meeting moved to 2pm.")
    assert quiet[-1]["type"] == "done" and "only when it is @mentioned" in quiet[-1]["note"]
    client.post("/api/teammate/admin", json={"enabled": False}, headers=LAB)
    off = stream(client, "/api/teammate/posts", ASK)
    assert "turned off" in off[-1]["threads"][0]["messages"][-1]["text"]
    assert model_calls(fake) == []


def test_turning_it_off_mid_answer_stops_at_the_next_tool_call(tmp_path: Path) -> None:
    client, fake = app(tmp_path, [[use("read_demand_plan", {}, 1)], [use("list_suppliers", {}, 2)]])
    service = client.app.state.container.teammate
    first = fake.messages.create

    def create(**params: Any) -> Any:
        if len(model_calls(fake)) == 1:  # the admin acts while the second reply is on its way
            service.admin(False, None, None)
        return first(**params)

    fake.messages.create = create
    events = stream(client, "/api/teammate/posts", ASK)
    assert events[-1]["type"] == "error" and "turned the agent off" in events[-1]["message"]
    assert events[-1]["threads"][0]["messages"][-1]["role"] == "system"


def test_a_refusal_a_cut_off_and_an_api_error_post_nothing(tmp_path: Path) -> None:
    import anthropic
    import httpx
    # A 400, which failover does not move to another model, so it reaches the agent part-way through its turn.
    bad_request = anthropic.APIStatusError("Bad request", response=httpx.Response(400, request=httpx.Request(
        "POST", "https://api.anthropic.com/v1/messages")), body=None)
    client, _ = app(tmp_path, [([text("I can't help with that.")], "refusal"),
                               ([use("read_demand_plan", {}, 1)], "max_tokens"),
                               [use("read_demand_plan", {}, 1)], bad_request])
    for expected in ("declined", "cut off", "Bad request"):
        events = stream(client, "/api/teammate/posts", ASK)
        assert events[-1]["type"] == "error" and expected in events[-1]["message"], events[-1]
        assert events[-1]["threads"][0]["messages"][-1]["role"] == "system"
    assert not client.get("/api/teammate/state", headers=LAB).json()["threads"][0]["busy"]


def test_a_shortlist_that_leaves_a_gap_must_say_so() -> None:
    # Found on the local model: "covers the gap exactly" for 16 of 18 batches, every number in it genuine.
    seen = {"docs": {"DOC-22", "DOC-24"}, "numbers": tm.numbers_in("10 6 3800 4600 65600 18 16"), "quality": {"S2", "S4"},
            "contracts": set(), "denied": set(), "stopped": False, "checks": 0}
    short = [{"supplier_id": "S2", "batches": 10, "why": "Cheapest."}, {"supplier_id": "S4", "batches": 6, "why": "Fast."}]
    claim = {"summary": "Cobalt and Vantage cover the gap exactly for £65,600.", "shortlist": short,
             "citations": ["DOC-22", "DOC-24"]}
    service = tm.TeammateService(None, SpendTracker(1.0), Path("/nonexistent"), today=lambda: TODAY)  # type: ignore[arg-type]
    assert any("2 are still short" in p for p in service.check_reply(claim, seen))
    honest = {**claim, "summary": "Cobalt and Vantage give 16 batches for £65,600, leaving us 2 short."}
    assert service.check_reply(honest, seen) == []


def test_coverage_checks_are_capped_so_it_has_to_choose(tmp_path: Path) -> None:
    tries = [[use("check_coverage", {"allocations": [{"supplier_id": "S1", "batches": n}]}, n)] for n in range(1, 7)]
    client, fake = app(tmp_path, [*tries, post({"summary": "No shortlist yet.", "shortlist": [], "citations": []})])
    events = stream(client, "/api/teammate/posts", ASK)
    assert events[-1]["type"] == "done"
    results = [m["content"][0] for m in (c["messages"][-1] for c in model_calls(fake)[1:]) if m["role"] == "user"]
    assert [r.get("is_error", False) for r in results[:6]] == [False] * tm.MAX_COVERAGE_CHECKS + [True, True]
    assert '"checks_left": 0' in results[tm.MAX_COVERAGE_CHECKS - 1]["content"]


def test_a_plain_text_answer_is_asked_once_for_post_reply(tmp_path: Path) -> None:
    client, fake = app(tmp_path, [[text("Brackenridge, I think.")], [text("Still Brackenridge.")]])
    events = stream(client, "/api/teammate/posts", ASK)
    assert events[-1]["type"] == "error" and "post_reply" in events[-1]["message"]
    assert len(model_calls(fake)) == 2


def test_a_follow_up_carries_its_own_thread_only(tmp_path: Path) -> None:
    other = {"summary": "Cobalt is a single site.", "shortlist": [], "citations": []}
    client, fake = app(tmp_path, [post(other, 1), post(other, 2), post(other, 3)])
    a = stream(client, "/api/teammate/posts", f"{tm.MENTION} tell me about Cobalt")
    stream(client, "/api/teammate/posts", f"{tm.MENTION} unrelated question about Vantage")
    thread_a = next(e["thread_id"] for e in a if e["type"] == "thread")
    stream(client, f"/api/teammate/threads/{thread_a}/replies", "And its lead time?")
    prompt = model_calls(fake)[2]["messages"][0]["content"]
    assert "tell me about Cobalt" in prompt and "Cobalt is a single site." in prompt and "Vantage" not in prompt
    assert prompt.rstrip().endswith("And its lead time?")


def test_two_replies_at_once_in_one_thread_cannot_both_run(tmp_path: Path) -> None:
    client, fake = app(tmp_path, [])
    service = client.app.state.container.teammate
    thread = service._write("INSERT INTO threads (created_at, author, kind) VALUES ('x', 'y', 'mention')")
    assert service._claim(thread)
    r = client.post(f"/api/teammate/threads/{thread}/replies", json={"text": "hello"}, headers=LAB)
    assert r.status_code == 409
    assert client.post("/api/teammate/reset", headers=LAB).status_code == 409  # not while it is answering
    service._release(thread)
    assert client.post("/api/teammate/reset", headers=LAB).status_code == 200


def test_input_is_validated(tmp_path: Path) -> None:
    client, _ = app(tmp_path, [])
    assert client.post("/api/teammate/posts", json={"text": ""}, headers=LAB).status_code == 400
    assert client.post("/api/teammate/posts", json={"text": "x" * 1001}, headers=LAB).status_code == 400
    assert client.post("/api/teammate/posts", json={"text": "hi", "model": "gpt-99"}, headers=LAB).status_code == 400
    assert client.post("/api/teammate/admin", json={"scopes": ["payroll"]}, headers=LAB).status_code == 400
    assert client.post("/api/teammate/coverage", json={"allocations": [{"supplier_id": "S1", "batches": -1}]},
                       headers=LAB).status_code == 400
    assert client.post("/api/teammate/threads/999/replies", json={"text": "hi"}, headers=LAB).status_code == 404
    assert client.post("/api/teammate/posts", json={"text": "hi"}).status_code == 403  # no lab header


def test_the_widget_uses_the_same_sums(tmp_path: Path) -> None:
    client, fake = app(tmp_path, [])
    out = client.post("/api/teammate/coverage", json={"allocations": [{"supplier_id": "S2", "batches": 10}],
                                                      "internal": 14}, headers=LAB).json()
    assert (out["covered"], out["gap_left"], out["cost_gbp"]) == (24, 6, 38000) and model_calls(fake) == []


# ----- posts of its own -----

def test_the_morning_check_nudges_owners_within_the_daily_limit(tmp_path: Path) -> None:
    nudge = {"text": "Morning! @Tom Kerr, Vantage's first-article inspection is due on 2026-11-20. "
                     "@Grace Whitfield, the Brackenridge tooling agreement is due 2026-11-27."}
    client, fake = app(tmp_path, [READ_ALL, CHECK, post(GOOD), [text(json.dumps(nudge))],
                                  [text(json.dumps({"text": "Just a reminder about the inspection."}))]])
    nothing = client.post("/api/teammate/morning-check", json={}, headers=LAB).json()
    assert not nothing["posted"] and "nothing has been shortlisted" in nothing["message"]
    stream(client, "/api/teammate/posts", ASK)

    first = client.post("/api/teammate/morning-check", json={}, headers=LAB).json()
    assert first["posted"] and first["threads"][0]["kind"] == "proactive"
    assert first["threads"][0]["messages"][0]["data"]["worded_by"] == "model"
    assert [d["owner"] for d in first["threads"][0]["messages"][0]["data"]["nudge"]] == ["Tom Kerr"]  # the tooling agreement is due in 9 days, outside the window

    second = client.post("/api/teammate/morning-check", json={}, headers=LAB).json()  # misses both owners
    assert second["posted"] and second["threads"][0]["messages"][0]["data"]["worded_by"].startswith("code")
    assert "@Tom Kerr" in second["threads"][0]["messages"][0]["text"]

    calls = len(model_calls(fake))
    third = client.post("/api/teammate/morning-check", json={}, headers=LAB).json()
    assert not third["posted"] and "limit" in third["message"] and len(model_calls(fake)) == calls

    client.post("/api/teammate/admin", json={"proactive": False}, headers=LAB)
    stopped = client.post("/api/teammate/morning-check", json={}, headers=LAB).json()
    assert not stopped["posted"] and "stopped" in stopped["message"]


def test_morning_checks_at_once_keep_to_the_daily_limit(tmp_path: Path) -> None:
    class SlowClaude:
        def create(self, **params: Any) -> Any:
            time.sleep(0.2)
            return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps(
                {"text": "@Tom Kerr @Grace Whitfield please check the open items."}))], stop_reason="end_turn",
                model=params["model"], usage=SimpleNamespace(input_tokens=10, output_tokens=10,
                                                             cache_read_input_tokens=0, cache_creation_input_tokens=0))

    service = tm.TeammateService(SlowClaude(), SpendTracker(5.0), tmp_path, None, today=lambda: TODAY)  # type: ignore[arg-type]
    service._shortlisted = lambda: ["S1", "S4"]  # type: ignore[method-assign]
    results: list[dict] = []
    workers = [threading.Thread(target=lambda: results.append(service.morning_check(None))) for _ in range(4)]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    assert sum(r["posted"] for r in results) == tm.PROACTIVE_DAILY_LIMIT
    assert service.proactive_today() == tm.PROACTIVE_DAILY_LIMIT and service._reserved == 0


# ----- found in review -----

def test_turning_it_off_while_it_writes_the_reply_stops_the_post(tmp_path: Path) -> None:
    client, fake = app(tmp_path, [READ_ALL, CHECK, post(GOOD)])
    service = client.app.state.container.teammate
    first = fake.messages.create

    def create(**params: Any) -> Any:
        if len(model_calls(fake)) == 2:  # the reply with only post_reply in it is on its way
            service.admin(False, None, None)
        return first(**params)

    fake.messages.create = create
    events = stream(client, "/api/teammate/posts", ASK)
    assert events[-1]["type"] == "error" and "turned the agent off" in events[-1]["message"]
    assert all(m["role"] != "agent" for m in events[-1]["threads"][0]["messages"])


def test_an_unexpected_error_still_ends_the_answer_in_the_thread(tmp_path: Path) -> None:
    client, _ = app(tmp_path, [[use("read_demand_plan", {}, 1)]])
    service = client.app.state.container.teammate

    def broken(*args: Any, **kwargs: Any) -> float:
        raise RuntimeError("spend log unavailable")

    service.spend.charge = broken
    events = stream(client, "/api/teammate/posts", ASK)
    assert events[-1]["type"] == "error" and "went wrong" in events[-1]["message"]
    thread = client.get("/api/teammate/state", headers=LAB).json()["threads"][0]
    assert thread["messages"][-1]["role"] == "system" and not thread["busy"]


def test_the_shortfall_must_be_stated_as_one() -> None:
    assert tm.states_shortfall("Together they leave us 2 short.", 2)
    assert tm.states_shortfall("A shortfall of 8 batches remains.", 8)
    assert not tm.states_shortfall("Cobalt has 8 batches available.", 8)
    assert not tm.states_shortfall("This covers the gap exactly.", 2)


def test_a_list_with_commas_is_not_read_as_one_number() -> None:
    assert tm.numbers_in("batches 6,8 for S1,S2") == {"6", "8", "1", "2"}
    assert tm.numbers_in("£1,250,000") == {"1250000"}


def test_the_handle_is_a_mention_too(tmp_path: Path) -> None:
    client, fake = app(tmp_path, [post({"summary": "Hello.", "shortlist": [], "citations": []})])
    events = stream(client, "/api/teammate/posts", f"@{tm.AGENT['handle']} are you there?")
    assert events[-1]["type"] == "done" and len(model_calls(fake)) == 1


def test_the_morning_check_follows_the_latest_shortlist_only(tmp_path: Path) -> None:
    service = tm.TeammateService(None, SpendTracker(1.0), tmp_path, None, today=lambda: TODAY)  # type: ignore[arg-type]
    thread = service._write("INSERT INTO threads (created_at, author, kind) VALUES ('x', 'y', 'mention')")
    service._post(thread, tm.AGENT_NAME, "agent", "first", {"shortlist": [{"supplier_id": "S2"}]})
    service._post(thread, tm.AGENT_NAME, "agent", "nudge", {"nudge": []})
    service._post(thread, tm.AGENT_NAME, "agent", "second", {"shortlist": [{"supplier_id": "S1"}]})
    service._post(thread, tm.AGENT_NAME, "agent", "none", {"shortlist": []})
    assert service._shortlisted() == ["S1"]


def test_a_failed_nudge_post_releases_only_its_own_slot(tmp_path: Path) -> None:
    class Claude:
        def create(self, **params: Any) -> Any:
            return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps({"text": "@Tom Kerr hi"}))],
                                   stop_reason="end_turn", model=params["model"],
                                   usage=SimpleNamespace(input_tokens=1, output_tokens=1, cache_read_input_tokens=0,
                                                         cache_creation_input_tokens=0))

    service = tm.TeammateService(Claude(), SpendTracker(5.0), tmp_path, None, today=lambda: TODAY)  # type: ignore[arg-type]
    service._shortlisted = lambda: ["S4"]  # type: ignore[method-assign]
    service._reserved = 1  # another check holds a slot while this one runs
    real_post = service._post

    def failing_post(*args: Any, **kwargs: Any) -> int:
        raise sqlite3.OperationalError("disk I/O error")

    service._post = failing_post  # type: ignore[method-assign]
    try:
        service.morning_check(None)
    except sqlite3.OperationalError:
        pass
    assert service._reserved == 1  # the other check's slot is untouched
    service._post = real_post  # type: ignore[method-assign]
