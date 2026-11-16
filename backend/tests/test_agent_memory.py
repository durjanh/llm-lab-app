"""Agent memory: the rules on what is kept (pure, no model), and whole turns through the routes with a scripted Claude."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import anthropic
import httpx
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services import agent_memory as am
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text, use
from backend.tests.test_api import LAB


def store(day: int = 1) -> dict[str, Any]:
    return {"user": "sam", "day": day, "next": 1, "memories": [], "sessions": {}, "log": []}


def keep(s: dict, said: str, **args: Any) -> dict:
    return am.remember(s, {"kind": "fact", "importance": 2, "value": "", **args}, said, 1)


# ----- the rules -----

def test_a_repeat_is_merged_a_change_replaces_and_a_guess_does_not_override() -> None:
    s = store()
    said = "I live in Leeds and I'm vegetarian."
    assert keep(s, said, subject="Home city", text="Sam lives in Leeds.", quote="I live in Leeds")["action"] == "added"
    again = keep(s, "Still in Leeds!", subject="home city", text="Sam lives in Leeds.", quote="Still in Leeds")
    assert again == {"action": "merged", "id": "m1"} and s["memories"][0]["uses"] == 1
    assert len(s["memories"][0]["sources"]) == 2  # provenance: both times it was said
    guess = keep(s, "I love the seaside.", subject="home city", text="Sam lives by the sea.", quote="I live by the sea")
    assert guess["action"] == "kept" and len(s["memories"]) == 1  # the quote is not in what Sam said
    moved = keep(s, "Big news: I've moved to Bristol.", subject="home city", text="Sam lives in Bristol.",
                 quote="I've moved to Bristol")
    assert moved == {"action": "replaced", "id": "m2", "replaces": "m1"}
    old, new = s["memories"]
    assert old["status"] == "superseded" and old["replaced_by"] == "m2" and new["replaces"] == "m1"
    assert new["sources"][0] == {"session": 1, "day": 1, "quote": "I've moved to Bristol", "by": "person"}


def test_the_privacy_guard_refuses_whatever_the_model_asks() -> None:
    s = store()
    card = keep(s, "Use my card 4111 1111 1111 1111 for bookings.", subject="payment card",
                text="Sam's card is 4111 1111 1111 1111.", quote="Use my card 4111 1111 1111 1111")
    assert card["action"] == "refused" and "card" in card["reason"] and s["memories"] == []
    # only what would be stored is judged: a harmless memory from the same message is kept
    harmless = keep(s, "I've moved to Bristol. Use my card 4111 1111 1111 1111.", subject="home city",
                    value="Bristol", text="Sam lives in Bristol.", quote="I've moved to Bristol")
    assert harmless["action"] == "added"


def test_memories_decay_by_kind_and_fade_below_the_floor() -> None:
    s = store()
    keep(s, "I'm allergic to peanuts.", subject="allergy", text="Sam is allergic to peanuts.",
         quote="I'm allergic to peanuts", importance=3)
    am.new_memory(s, kind="episode", subject="session 1", text="Sam booked a hotel in York.", importance=1,
                  sources=[{"session": 1, "day": 1, "quote": "", "by": "agent"}])
    s["day"] = 40
    assert am.maintain(s) == []  # 39 days: the episode is at 0.4, still above 0.3
    s["day"] = 70
    [gone] = am.maintain(s)
    assert gone["kind"] == "episode" and gone["status"] == "forgotten" and "69 days unused" in gone["reason"]
    assert s["memories"][0]["status"] == "active" and am.strength(s["memories"][0], 70) > 2.5  # the allergy stays


def test_the_profile_is_always_there_and_one_offs_only_when_they_match() -> None:
    """A question rarely shares words with the preference that answers it: "dinner" never matched "vegetarian"."""
    s = store()
    keep(s, "I'm allergic to peanuts.", subject="allergy", text="Sam is allergic to peanuts.", quote="", importance=3)
    keep(s, "I'm vegetarian.", subject="diet", text="Sam is vegetarian.", quote="")
    keep(s, "I'm off to York.", subject="trip", text="Sam is visiting York on Saturday.", quote="", importance=1)
    got = am.retrieve(s["memories"], "What should I cook for dinner tonight?", 1)
    assert [r["id"] for r in got] == ["m1", "m2"] and {r["why"] for r in got} == {"profile: in every request"}
    trip = am.retrieve(s["memories"], "Any tips for York?", 1)
    assert [r["id"] for r in trip] == ["m1", "m2", "m3"] and trip[-1]["why"] == "matches the message"


# ----- whole turns, with a scripted Claude -----

def make(tmp_path: Path, script: list[Any], budget: float = 5.0) -> tuple[TestClient, ScriptedClient]:
    fake = ScriptedClient(script)
    settings = Settings(port=8000, budget_usd=budget, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    return TestClient(create_app(settings, client=fake), base_url="http://localhost:8000"), fake


def say(client: TestClient, user: str, sid: str, words: str) -> Any:
    return client.post(f"/api/agent-memory/people/{user}/sessions/{sid}/messages", headers=LAB, json={"text": words})


def test_a_session_keeps_what_claude_asked_and_the_next_session_uses_it(tmp_path: Path) -> None:
    client, fake = make(tmp_path, [
        [use("remember", {"kind": "fact", "subject": "home city", "text": "Sam lives in Leeds.",
                          "quote": "I live in Leeds", "importance": 2}, 1),
         use("remember", {"kind": "preference", "subject": "diet", "text": "Sam is vegetarian.",
                          "quote": "I'm vegetarian", "importance": 2}, 2)],
        [text("Noted, Sam.")],
        [text("Sam had an introductory chat.")],  # the episode
        [text("A vegetable curry [m2], since you are vegetarian.")],
    ])
    sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    first = say(client, "sam", sid, "Hi, I'm Sam. I live in Leeds and I'm vegetarian.").json()
    assert [d["action"] for d in first["decisions"]] == ["added", "added"] and first["cost_usd"] > 0
    ended = client.post(f"/api/agent-memory/people/sam/sessions/{sid}/end", headers=LAB, json={}).json()
    episode = next(m for m in ended["memories"] if m["kind"] == "episode")
    assert episode["compression"]["from_tokens"] > episode["compression"]["to_tokens"]
    assert say(client, "sam", sid, "hello?").status_code == 404  # an ended session takes no more messages

    sid2 = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    second = say(client, "sam", sid2, "What should I cook for dinner tonight?").json()
    system = fake.calls[-1][1]["system"]
    assert "[m2] (preference, diet) Sam is vegetarian." in system and 'said on day 1: "I\'m vegetarian"' in system
    assert fake.calls[-1][1]["messages"] == [{"role": "user", "content": "What should I cook for dinner tonight?"}]
    diet = next(m for m in second["memories"] if m["id"] == "m2")
    assert second["cited"] == ["m2"] and diet["uses"] == 1  # a used memory is strengthened


def test_one_person_never_sees_anothers_memories(tmp_path: Path) -> None:
    client, fake = make(tmp_path, [
        [use("remember", {"kind": "fact", "subject": "home city", "text": "Sam lives in Leeds.",
                          "quote": "I live in Leeds", "importance": 2})],
        [text("Got it.")],
        [text("I don't know anything about Sam.")],
    ])
    sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    say(client, "sam", sid, "I live in Leeds.")
    other = client.post("/api/agent-memory/people/priya/sessions", headers=LAB).json()["session"]
    got = say(client, "priya", other, "Where does Sam live in Leeds?").json()
    assert got["retrieved"] == [] and "Leeds" not in fake.calls[-1][1]["system"] and got["memories"] == []
    assert client.post(f"/api/agent-memory/people/priya/sessions/{sid}/messages", headers=LAB,
                       json={"text": "hi"}).status_code == 404  # Sam's session is not Priya's


def test_a_turn_that_fails_part_way_keeps_nothing(tmp_path: Path) -> None:
    overloaded = anthropic.APIStatusError("overloaded", response=httpx.Response(
        529, request=httpx.Request("POST", "http://test/v1/messages")), body=None)
    client, _ = make(tmp_path, [
        [use("remember", {"kind": "fact", "subject": "home city", "text": "Sam lives in Leeds.",
                          "quote": "I live in Leeds", "importance": 2})],
        overloaded,
    ])
    sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    r = say(client, "sam", sid, "I live in Leeds.")
    assert r.status_code >= 500 and client.get("/api/agent-memory/people/sam", headers=LAB).json()["memories"] == []


def test_a_refusal_or_an_empty_reply_is_an_error_that_saves_nothing(tmp_path: Path) -> None:
    client, _ = make(tmp_path, [([text("")], "refusal"), [text("   ")]])
    sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    assert say(client, "sam", sid, "hello").status_code >= 400
    assert say(client, "sam", sid, "hello").status_code == 502
    state = client.get("/api/agent-memory/people/sam", headers=LAB).json()
    assert state["memories"] == [] and all(s["messages"] == 0 for s in state["sessions"])


def test_time_passing_lets_one_off_episodes_fade(tmp_path: Path) -> None:
    client, _ = make(tmp_path, [[text("Have a lovely trip!")], [text("Sam is booking a hotel in York.")]])
    sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    say(client, "sam", sid, "I'm booking a hotel in York this weekend.")
    client.post(f"/api/agent-memory/people/sam/sessions/{sid}/end", headers=LAB, json={})
    later = client.post("/api/agent-memory/people/sam/clock", headers=LAB, json={"days": 90}).json()
    [episode] = later["memories"]
    assert later["day"] == 91 and episode["status"] == "forgotten" and "faded" in episode["reason"]


def test_names_and_models_are_checked_and_messages_need_budget(tmp_path: Path) -> None:
    client, _ = make(tmp_path, [], budget=0.0)
    assert client.get("/api/agent-memory/people/..%2Fetc", headers=LAB).status_code in (400, 404)
    assert client.get("/api/agent-memory/people/Sam", headers=LAB).status_code == 400
    sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    assert say(client, "sam", sid, "hi").status_code == 429  # the budget guard: a message spends, and none is left
    client2, _ = make(tmp_path / "b", [])
    sid2 = client2.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    r = client2.post(f"/api/agent-memory/people/sam/sessions/{sid2}/messages", headers=LAB,
                     json={"text": "hi", "model": "gpt-4"})
    assert r.status_code == 400


def test_a_cut_off_reply_is_a_clear_error_and_a_cut_off_episode_still_ends_the_session(tmp_path: Path) -> None:
    """Found on a real run: Haiku's thinking used up the episode's 200 tokens, the summary was cut off, and the
    RuntimeError from the check became a 500, so the session could not end."""
    client, fake = make(tmp_path, [
        ([text("Half a sente")], "max_tokens"),  # a turn cut off
        [text("Noted.")],
        ([text("Sam talked ab")], "max_tokens"),  # the episode cut off
    ])
    sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    cut = say(client, "sam", sid, "I live in Leeds.")
    assert cut.status_code == 502 and cut.json()["error"]["type"] == "cut_off"
    assert say(client, "sam", sid, "I live in Leeds.").status_code == 200
    ended = client.post(f"/api/agent-memory/people/sam/sessions/{sid}/end", headers=LAB, json={})
    assert ended.status_code == 200 and ended.json()["episode"] is None
    assert any("no episode" in entry["detail"] for entry in ended.json()["log"])
    assert all(call[1]["output_config"] == {"effort": "low"} for call in fake.calls)  # thinking kept short
    assert fake.calls[-1][1]["max_tokens"] >= 1000



def test_lessons_from_the_real_run() -> None:
    """Three things a run on real Claude showed that a scripted model did not."""
    s = store()
    keep(s, "I'm vegetarian.", subject="diet", value="vegetarian", text="Sam is vegetarian.", quote="I'm vegetarian")
    again = keep(s, "I'm still vegetarian.", subject="diet", value="still vegetarian",
                 text="Sam is vegetarian and confirmed this again on day 3.", quote="I'm still vegetarian")
    assert again["action"] == "merged" and len(s["memories"]) == 1  # a restatement, not a change
    keep(s, "I live in Leeds.", subject="home city", value="Leeds", text="Sam lives in Leeds.", quote="I live in Leeds")
    moved = keep(s, "I've moved to Bristol.", subject="home city", value="Bristol",
                 text="Sam lived in Leeds and now lives in Bristol.", quote="moved to Bristol")
    assert moved["action"] == "replaced"  # every word of the old sentence is in the new one, and still a change
    keep(s, "Saturday I'm off to York.", subject="saturday plan", text="Sam is going to York on Saturday.",
         quote="Saturday I'm off to York", importance=1)  # filed as a fact, but a one-off
    s["day"] = 63
    assert [m["subject"] for m in am.maintain(s)] == ["saturday plan"]


def test_careless_instructions_reach_the_model_and_the_guard_still_refuses(tmp_path: Path) -> None:
    client, fake = make(tmp_path, [
        [use("remember", {"kind": "fact", "subject": "payment card", "text": "Sam's card is 4111 1111 1111 1111.",
                          "quote": "use my card 4111 1111 1111 1111", "importance": 2})],
        [text("I won't keep card numbers.")],
    ])
    sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    got = client.post(f"/api/agent-memory/people/sam/sessions/{sid}/messages", headers=LAB,
                      json={"text": "For bookings, use my card 4111 1111 1111 1111.", "careless": True}).json()
    assert "word for word" in fake.calls[0][1]["system"]
    assert got["decisions"][0]["action"] == "refused" and got["memories"] == []



# ----- review findings -----

def test_forget_matches_whole_words_and_a_bad_importance_is_not_a_crash() -> None:
    s = store()
    keep(s, "I speak Welsh.", subject="language", value="Welsh", text="Sam speaks Welsh.", quote="")
    keep(s, "I'm 40.", subject="age", value="40", text="Sam is 40.", quote="", importance="high")
    assert s["memories"][1]["importance"] == 2  # "high" is not a number: the default, not a 500
    gone = am.forget(s, {"subject": "age"}, 1)
    assert gone["ids"] == ["m2"] and s["memories"][0]["status"] == "active"  # "language" contains "age" as letters


def test_an_episode_of_nothing_is_not_kept_and_a_refused_one_is_logged(tmp_path: Path) -> None:
    client, _ = make(tmp_path, [[text("Hello!")], [text("Nothing.")], [text("Hi.")],
                                [text("Sam's password is hunter2, shared by mistake.")]])
    for _ in range(2):
        sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
        say(client, "sam", sid, "Hello")
        ended = client.post(f"/api/agent-memory/people/sam/sessions/{sid}/end", headers=LAB, json={}).json()
        assert ended["episode"] is None
    assert any(e["event"] == "refused" and "password" in e["detail"] for e in ended["log"])


def test_a_reply_still_asking_for_tools_after_the_last_round_is_not_an_answer(tmp_path: Path) -> None:
    calls = [[text("Let me save that."), use("remember", {"kind": "fact", "subject": f"s{i}", "value": "v",
                                                          "text": f"Sam fact {i}.", "quote": "", "importance": 2}, i)]
             for i in range(am.MAX_TOOL_ROUNDS + 1)]
    client, _ = make(tmp_path, calls)
    sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    r = say(client, "sam", sid, "Remember lots.")
    assert r.status_code == 502 and r.json()["error"]["type"] == "too_many_tools"
    assert client.get("/api/agent-memory/people/sam", headers=LAB).json()["memories"] == []


def test_a_file_of_the_wrong_shape_says_to_reset_and_new_people_are_capped(tmp_path: Path, monkeypatch) -> None:
    client, _ = make(tmp_path, [])
    folder = tmp_path / "agent-memory-lab"
    folder.mkdir()
    (folder / "sam.json").write_text("{}")
    r = client.get("/api/agent-memory/people/sam", headers=LAB)
    assert r.status_code == 500 and "Reset it" in r.json()["error"]["message"]
    assert client.delete("/api/agent-memory/people/sam", headers=LAB).status_code == 200
    monkeypatch.setattr(am, "MAX_PEOPLE", 1)
    client.post("/api/agent-memory/people/sam/sessions", headers=LAB)
    assert client.post("/api/agent-memory/people/priya/sessions", headers=LAB).status_code == 400



def test_a_copied_transcript_is_not_kept_as_an_episode(tmp_path: Path) -> None:
    """Found on a real run of the local model: asked for one sentence, it sent the conversation back."""
    client, fake = make(tmp_path, [[text("Try a risotto.")],
                                   [text("User: What could I cook?\nAssistant: Try a risotto.")]])
    sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    say(client, "sam", sid, "What could I cook?")
    ended = client.post(f"/api/agent-memory/people/sam/sessions/{sid}/end", headers=LAB, json={}).json()
    assert ended["episode"] is None and any("instead of a short summary" in e["detail"] for e in ended["log"])
    asked = fake.calls[-1][1]["messages"][0]["content"]
    assert asked.startswith("<transcript>") and asked.rstrip().endswith("Write only the sentences.")


def test_the_default_is_the_labs_default_model(tmp_path: Path) -> None:
    client, fake = make(tmp_path, [[text("Hello.")]])
    sid = client.post("/api/agent-memory/people/sam/sessions", headers=LAB).json()["session"]
    say(client, "sam", sid, "Hi")
    assert fake.calls[-1][1]["model"] == am.DEFAULT_MODEL
    assert client.get("/api/agent-memory/info", headers=LAB).json()["model"] == am.DEFAULT_MODEL
