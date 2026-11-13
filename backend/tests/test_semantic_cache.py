"""The semantic cache: hits, misses, scopes, expiry and the two checks, with a fake store, a fake embedder and a scripted
model, so no Docker and no cost. A last test runs against a real pgvector when one is running."""
from __future__ import annotations

import json
import math
import time
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.api import deps
from backend.app.gateways.claude import ClaudeGateway
from backend.app.gateways.semantic_cache import PgSemanticCache
from backend.app.main import create_app
from backend.app.services.semantic_cache import PAIRS, SemanticCacheService, numbers
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB

# Questions that should look alike to the fake embedder share a word from this list.
WORDS = ["leave", "remote", "expenses", "budget", "carry", "book", "cancel"]


class FakeEmbedder:
    model = "ai/fake-embed"

    def status(self) -> dict[str, Any]:
        return {"configured": True, "running": True, "has_model": True, "model": self.model}

    def embed(self, texts: list[str], kind: str = "document") -> list[list[float]]:
        out = []
        for t in texts:
            v = [float(w in t.lower()) for w in WORDS] + [0.05]
            n = math.sqrt(sum(x * x for x in v))
            out.append([x / n for x in v])
        return out


class FakeCache:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    def status(self) -> dict[str, Any]:
        return {"running": True, "where": "fake"}

    def nearest(self, dims: int, embed_model: str, scope: str, vector: list[float], k: int, ttl_s: int) -> list[dict[str, Any]]:
        now = time.time()
        rows = [r for r in self.rows if r["scope"] == scope and now - r["at"] < ttl_s]
        scored = [{**r, "similarity": sum(a * b for a, b in zip(r["v"], vector))} for r in rows]
        return sorted(scored, key=lambda r: -r["similarity"])[:k]

    def put(self, dims: int, embed_model: str, scope: str, question: str, answer: str, vector: list[float],
            cost_usd: float, ms: float) -> int:
        self.rows.append({"id": len(self.rows) + 1, "scope": scope, "question": question, "answer": answer, "v": vector,
                          "cost_usd": cost_usd, "ms": ms, "hits": 0, "at": time.time()})
        return len(self.rows)

    def hit(self, dims: int, entry_id: int) -> None:
        self.rows[entry_id - 1]["hits"] += 1

    def entries(self, dims: int, embed_model: str, scope: str | None) -> list[dict[str, Any]]:
        return [{k: r[k] for k in ("id", "scope", "question", "answer", "hits")} for r in self.rows]

    def clear(self, dims: int, embed_model: str) -> int:
        n, self.rows = len(self.rows), []
        return n


def verdict(same: bool) -> list[dict]:
    return [text(json.dumps({"same_answer": same, "reason": "checked"}))]


def make(tmp_path: Path, script: list) -> tuple[TestClient, ScriptedClient, FakeCache]:
    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    fake = ScriptedClient(script)
    app = create_app(settings, client=fake)
    store = FakeCache()
    service = SemanticCacheService(store, FakeEmbedder(), ClaudeGateway(fake), SpendTracker(1.0))
    app.dependency_overrides[deps.semantic_cache] = lambda: service
    return TestClient(app, base_url="http://localhost:8000"), fake, store


ASK = {"model": "claude-haiku-5-5", "threshold": 0.8}


def test_numbers_are_compared_as_digits() -> None:
    assert numbers("Is my budget £1,000?") == ["1000"] and numbers("Carry over five days?") == ["5"]
    assert numbers("Carry over 5 days") == numbers("carry over five days")
    assert numbers("How do I book leave?") == []
    # every trap pair with different numbers is caught by code alone
    assert [numbers(p["a"]) == numbers(p["b"]) for p in PAIRS if "carry" in p["a"] or "£" in p["a"]] == [False, False]


def test_a_miss_is_answered_and_cached_then_a_paraphrase_hits(tmp_path: Path) -> None:
    client, fake, store = make(tmp_path, [[text("25 days a year.")], verdict(True)])
    first = client.post("/api/semantic-cache/ask", headers=LAB, json={**ASK, "question": "How much annual leave?"}).json()
    assert first["hit"] is False and first["answer"] == "25 days a year." and first["cost_usd"] > 0
    assert len(store.rows) == 1 and "Northwind" in fake.calls[0][1]["system"]
    again = client.post("/api/semantic-cache/ask", headers=LAB, json={**ASK, "question": "Leave allowance per year?"}).json()
    assert again["hit"] is True and again["answer"] == "25 days a year." and again["matched"] == "How much annual leave?"
    assert fake.calls[-1][1]["model"] == "claude-haiku-5-5" and "Question B" in fake.calls[-1][1]["messages"][0]["content"]
    assert again["checked"][-1]["passed"] is True and store.rows[0]["hits"] == 1
    assert again["stats"]["hits"] == 1 and again["stats"]["misses"] == 1


def test_the_checks_stop_a_close_question_with_a_different_answer(tmp_path: Path) -> None:
    client, fake, store = make(tmp_path, [[text("Yes, up to 5.")], [text("No, only 5.")],
                                          [text("Book on the HR portal.")], verdict(False), [text("Cancel by email.")]])
    client.post("/api/semantic-cache/ask", headers=LAB, json={**ASK, "question": "Can I carry over 5 days?"})
    other = client.post("/api/semantic-cache/ask", headers=LAB, json={**ASK, "question": "Can I carry over 10 days?"}).json()
    assert other["hit"] is False and other["checked"][0]["by"] == "numbers"  # caught by code, no check call
    client.post("/api/semantic-cache/ask", headers=LAB, json={**ASK, "question": "How do I book leave?"})
    cancel = client.post("/api/semantic-cache/ask", headers=LAB, json={**ASK, "question": "How do I book or cancel leave?"}).json()
    assert cancel["hit"] is False and cancel["checked"][0] == {"id": 3, "passed": False, "by": "model", "reason": "checked"}
    assert cancel["answer"] == "Cancel by email." and fake.script == []


def test_with_checks_off_the_threshold_alone_decides(tmp_path: Path) -> None:
    client, _, _ = make(tmp_path, [[text("Yes, up to 5.")]])
    client.post("/api/semantic-cache/ask", headers=LAB, json={**ASK, "question": "Can I carry over 5 days?"})
    wrong = client.post("/api/semantic-cache/ask", headers=LAB, json={
        **ASK, "question": "Can I carry over 10 days?", "check_numbers": False, "check_model": False}).json()
    assert wrong["hit"] is True and wrong["answer"] == "Yes, up to 5."  # the failure the page warns about


def test_scopes_keep_users_and_models_apart_and_entries_expire(tmp_path: Path) -> None:
    client, _, store = make(tmp_path, [[text("A")], [text("B")], [text("C")], [text("D")]])
    q = {**ASK, "question": "How much annual leave?", "check_model": False}
    client.post("/api/semantic-cache/ask", headers=LAB, json=q)
    assert client.post("/api/semantic-cache/ask", headers=LAB, json={**q, "user": "sam"}).json()["hit"] is False
    assert client.post("/api/semantic-cache/ask", headers=LAB, json={**q, "model": "claude-sonnet-5-5"}).json()["hit"] is False
    store.rows[0]["at"] -= 100
    assert client.post("/api/semantic-cache/ask", headers=LAB, json={**q, "ttl_s": 60}).json()["hit"] is False
    assert client.post("/api/semantic-cache/ask", headers=LAB, json={**q, "user": "nobody"}).status_code == 400
    assert client.post("/api/semantic-cache/ask", json=q).status_code in (400, 403)
    assert client.post("/api/semantic-cache/clear", headers=LAB).json() == {"deleted": 4}


def test_pairs_are_scored_free_and_checked_on_request(tmp_path: Path) -> None:
    client, fake, _ = make(tmp_path, [verdict(p["same"]) for p in PAIRS])
    pairs = client.post("/api/semantic-cache/pairs", headers=LAB).json()["pairs"]
    assert len(pairs) == len(PAIRS) and all("similarity" in p and "numbers_match" in p for p in pairs)
    assert fake.calls == []  # similarity costs nothing
    checked = client.post("/api/semantic-cache/pairs/verify", headers=LAB).json()
    assert [p["same_answer"] for p in checked["pairs"]] == [p["same"] for p in PAIRS] and checked["cost_usd"] > 0


def test_against_a_real_pgvector_when_one_is_running() -> None:
    cache = PgSemanticCache("postgresql://lab:lab@127.0.0.1:5433/vectors")
    cache.db.connect_timeout_s = 1
    if not cache.status().get("running"):
        pytest.skip("No pgvector on 127.0.0.1:5433 (./tools/vector-db.sh starts one).")
    model = f"test-{uuid.uuid4().hex[:8]}"
    try:
        entry = cache.put(3, model, "s", "How much leave?", "25 days", [1, 0, 0], 0.001, 900)
        assert cache.nearest(3, model, "s", [0.9, 0.1, 0], 3, 3600)[0]["id"] == entry
        assert cache.nearest(3, model, "other", [1, 0, 0], 3, 3600) == []
        cache.hit(3, entry)
        assert cache.entries(3, model, "s")[0]["hits"] == 1
    finally:
        import psycopg

        with psycopg.connect(cache.db.url) as conn:
            conn.execute("DROP TABLE IF EXISTS semcache_3")
