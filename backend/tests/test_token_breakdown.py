"""The token counter's word-by-word breakdown, with a fake count: the parts always add up to the total."""
from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.services.messages import MAX_PIECES, split_words, token_breakdown
from backend.tests.test_api import LAB, FakeClient, make_client


def fake_count(model: str, messages: list[dict], system: str | None = None) -> int:
    """5 tokens of framing, 3 for a system prompt's wrapping, and one token per 4 characters, rounded up."""
    text = messages[0]["content"]
    return 5 + (3 + len(system) // 4 if system else 0) + -(-len(text) // 4)


def test_split_words_keeps_every_character() -> None:
    prompt = "  How many\ndays,  of leave?  "
    pieces = split_words(prompt)
    assert "".join(pieces) == prompt and pieces[0] == "  How" and pieces[2] == "\ndays,"
    long = " ".join(f"w{i}" for i in range(400))
    grouped = split_words(long)
    assert len(grouped) <= MAX_PIECES and "".join(grouped) == long


def test_the_parts_add_up_to_the_total() -> None:
    system, prompt = "Answer from the handbook only.", "How many days of annual leave do I get?"
    r = token_breakdown(fake_count, "claude-haiku-5-5", system, prompt)
    assert r["total"] == fake_count("m", [{"content": prompt}], system)
    assert r["framing"] == 5 and r["system"] == 3 + len(system) // 4
    assert r["framing"] + r["system"] + sum(w["tokens"] for w in r["words"]) == r["total"]
    assert r["prompt"] == sum(w["tokens"] for w in r["words"])
    assert [w["text"] for w in r["words"]][:3] == ["How", " many", " days"]
    no_system = token_breakdown(fake_count, "claude-haiku-5-5", "", prompt)
    assert no_system["system"] == 0 and no_system["total"] == r["total"] - r["system"]


def test_the_route_needs_a_claude_model(tmp_path) -> None:
    client: TestClient = make_client(FakeClient(), tmp_path)
    bad = client.post("/api/count_tokens/breakdown", headers=LAB, json={"model": "gpt-5.4-mini", "prompt": "hi"})
    assert bad.status_code in (400, 422)
