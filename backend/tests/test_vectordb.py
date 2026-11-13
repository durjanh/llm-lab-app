"""The vector database page: chunking, the SQL, and the routes, with a fake database and a fake embedder, so no
Docker and no cost. A last test runs against a real pgvector when one is running (./tools/vector-db.sh)."""
from __future__ import annotations

import math
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.api import deps
from backend.app.gateways.claude import ClaudeGateway
from backend.app.gateways.pgvector import (PgVector, VectorDbUnavailable, hybrid_sql, keyword_sql, literal,
                                           semantic_sql, table)
from backend.app.main import create_app
from backend.app.services.spend import SpendTracker
from backend.app.services.vectordb import CHUNK_CHARS, VectorDbService, chunk, cited, samples
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB

WORDS = ["leave", "holiday", "sick", "blood", "fast", "pension"]


class FakeEmbedder:
    """A vector per text from the words it contains: texts sharing words point the same way."""
    model = "ai/fake-embed"

    def __init__(self) -> None:
        self.calls: list[tuple[int, str]] = []

    def status(self) -> dict[str, Any]:
        return {"configured": True, "running": True, "has_model": True, "model": self.model}

    def embed(self, texts: list[str], kind: str = "document") -> list[list[float]]:
        self.calls.append((len(texts), kind))
        out = []
        for t in texts:
            v = [float(t.lower().count(w)) for w in WORDS] + [0.1]
            n = math.sqrt(sum(x * x for x in v))
            out.append([x / n for x in v])
        return out


class FakeStore:
    """An in-memory stand-in for PgVector, ranking by dot product and by shared words."""

    def __init__(self, down: bool = False) -> None:
        self.rows: list[dict[str, Any]] = []
        self.down = down

    def _check(self) -> None:
        if self.down:
            raise VectorDbUnavailable("PostgreSQL did not answer. Start it with ./tools/vector-db.sh.")

    def status(self) -> dict[str, Any]:
        return {"running": not self.down, "where": "fake"}

    def add(self, model: str, dims: int, collection: str, source: str, chunks: list[str], vectors: list[list[float]],
            access: str = "everyone", tags: list[str] | None = None) -> int:
        self._check()
        self.rows = [r for r in self.rows if (r["model"], r["collection"], r["source"]) != (model, collection, source)]
        self.rows += [{"model": model, "collection": collection, "source": source, "chunk": i, "content": c, "v": v,
                       "access": access, "tags": list(tags or [])} for i, (c, v) in enumerate(zip(chunks, vectors))]
        return len(chunks)

    def sources(self, model: str, dims: int) -> list[dict[str, Any]]:
        self._check()
        seen: dict[tuple[str, str], int] = {}
        for r in self.rows:
            seen[(r["collection"], r["source"])] = seen.get((r["collection"], r["source"]), 0) + 1
        return [{"collection": c, "source": s, "chunks": n} for (c, s), n in seen.items()]

    def remove(self, model: str, dims: int, collection: str, source: str | None) -> int:
        self._check()
        keep = [r for r in self.rows if not (r["collection"] == collection and source in (None, r["source"]))]
        deleted, self.rows = len(self.rows) - len(keep), keep
        return deleted

    def search(self, model: str, dims: int, collection: str, text: str, vector: list[float], k: int,
               groups: list[str] | None = None, tags: list[str] | None = None) -> dict[str, Any]:
        self._check()
        self.last_groups = groups
        everything = [r for r in self.rows if r["collection"] == collection and r["model"] == model]
        rows = [r for r in everything if (groups is None or r["access"] in groups)
                and (not tags or set(tags) & set(r["tags"]))]
        semantic = sorted(rows, key=lambda r: -sum(a * b for a, b in zip(r["v"], vector)))[:k]
        words = set(text.lower().split())
        keyword = [r for r in rows if words & set(r["content"].lower().split())][:k]
        shape = lambda rs: [{"source": r["source"], "chunk": r["chunk"], "content": r["content"]} for r in rs]  # noqa: E731
        return {"semantic": {"sql": "", "ms": 0, "rows": shape(semantic)},
                "keyword": {"sql": "", "ms": 0, "rows": shape(keyword)},
                "hybrid": {"sql": "", "ms": 0, "rows": shape(semantic)}, "plan": "",
                "visible": len(rows), "hidden": len(everything) - len(rows)}


def test_chunks_keep_their_heading_and_stay_under_the_size() -> None:
    doc = "# Handbook\n\nIntro line.\n\n## Annual leave\n\n" + "You get 25 days a year. " * 60 + "\n\n## Pension\n\nThe firm adds 5%."
    chunks = chunk(doc)
    assert all(len(c) <= CHUNK_CHARS for c in chunks)
    assert chunks[0] == "# Handbook\nIntro line."
    leave = [c for c in chunks if "25 days" in c]
    assert len(leave) > 1 and all(c.startswith("## Annual leave\n") for c in leave)  # a long section is split...
    assert chunks[-1] == "## Pension\nThe firm adds 5%."  # ...and each chunk still says what it is about
    assert chunk("   \n\n  ") == []
    assert all(len(c) <= CHUNK_CHARS for c in chunk("x" * 3000))  # one huge word is still cut


def test_both_sample_sets_load_and_chunk() -> None:
    sets = samples()
    assert set(sets) == {"handbook", "medassist", "restricted"} and len(sets["medassist"]["documents"]) == 3
    assert {a for a, _ in sets["restricted"]["access"].values()} == {"hr", "managers"}
    assert all(chunk(t) for s in sets.values() for t in s["documents"].values())


def test_citations_outside_the_passages_are_caught() -> None:
    assert cited("Yes [1], and [3]. Also [1].", 3) == ([1, 3], [])
    assert cited("See [0] and [7].", 3) == ([], [0, 7])


def test_the_sql_filters_by_model_and_collection_and_sends_vectors_as_parameters() -> None:
    for sql in (semantic_sql(768), keyword_sql(768), hybrid_sql(768)):
        assert "chunks_768" in sql and "%(model)s" in sql and "%(collection)s" in sql
    assert "<=>" in semantic_sql(768) and "%(vector)s::vector" in semantic_sql(768)
    assert "FULL OUTER JOIN" in hybrid_sql(768) and "1.0 / (60 + s.place)" in hybrid_sql(768)
    assert literal([0.5, -0.25]) == "[0.5,-0.25]"
    for bad in (0, 5000, "768; DROP TABLE x"):
        with pytest.raises(ValueError):
            table(bad)  # type: ignore[arg-type]


def make(tmp_path: Path, store: Any, script: list | None = None) -> tuple[TestClient, Any, FakeEmbedder]:
    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    fake_claude = ScriptedClient(script or [])
    app = create_app(settings, client=fake_claude)
    embedder = FakeEmbedder()
    service = VectorDbService(store, embedder, ClaudeGateway(fake_claude), SpendTracker(1.0))
    app.dependency_overrides[deps.vectordb] = lambda: service
    return TestClient(app, base_url="http://localhost:8000"), fake_claude, embedder


def test_documents_are_added_searched_replaced_and_removed(tmp_path: Path) -> None:
    store = FakeStore()
    client, _, embedder = make(tmp_path, store)
    r = client.post("/api/vectordb/samples/handbook", headers=LAB)
    assert r.status_code == 200 and r.json()["chunks"] > 3
    doc = "## Leave\n\nYou get 25 days holiday leave.\n\n## Blood\n\nFast before a blood test only if told to."
    added = client.post("/api/vectordb/documents", headers=LAB, json={"collection": "mine", "source": "notes", "text": doc})
    assert added.json()["chunks"] == 2 and added.json()["dims"] == len(WORDS) + 1
    client.post("/api/vectordb/documents", headers=LAB, json={"collection": "mine", "source": "notes", "text": doc})
    assert sum(r["source"] == "notes" for r in store.rows) == 2  # the same name replaces, not duplicates

    found = client.post("/api/vectordb/search", headers=LAB, json={"collection": "mine", "query": "blood fast", "k": 1})
    assert found.status_code == 200
    assert found.json()["semantic"]["rows"][0]["content"].startswith("## Blood")
    assert embedder.calls[-1] == (1, "query")  # the question is embedded as a query, not a document

    status = client.get("/api/vectordb/status", headers=LAB).json()
    assert {"collection": "mine", "source": "notes", "chunks": 2} in status["sources"] and status["dims"] == 7
    assert "CREATE TABLE IF NOT EXISTS chunks_7" in status["create_sql"]

    assert client.post("/api/vectordb/remove", headers=LAB, json={"collection": "mine", "source": "notes"}).json() == {"deleted": 2}
    assert client.post("/api/vectordb/remove", headers=LAB, json={"collection": "handbook"}).json()["deleted"] > 3
    assert store.rows == []


def test_bad_input_and_a_stopped_database_get_clear_errors(tmp_path: Path) -> None:
    client, _, _ = make(tmp_path, FakeStore(down=True))
    r = client.post("/api/vectordb/search", headers=LAB, json={"collection": "mine", "query": "x"})
    assert r.status_code == 503 and "vector-db.sh" in r.json()["error"]["message"]
    assert client.post("/api/vectordb/search", json={"collection": "mine", "query": "x"}).status_code in (400, 403)
    assert client.post("/api/vectordb/search", headers=LAB, json={"collection": "a;b", "query": "x"}).status_code in (400, 422)
    assert client.post("/api/vectordb/search", headers=LAB, json={"collection": "a", "query": "x", "k": 50}).status_code in (400, 422)
    assert client.post("/api/vectordb/samples/nope", headers=LAB).status_code == 404


def test_an_answer_cites_the_passages_and_is_charged(tmp_path: Path) -> None:
    store = FakeStore()
    client, fake_claude, _ = make(tmp_path, store, [[text("Only if told to [1]. Not in [9].")]])
    client.post("/api/vectordb/documents", headers=LAB, json={
        "collection": "mine", "source": "notes", "text": "## Blood\n\nFast before a blood test only if told to."})
    r = client.post("/api/vectordb/answer", headers=LAB,
                    json={"collection": "mine", "query": "fast blood", "k": 3, "model": "claude-haiku-5-5"})
    body = r.json()
    assert r.status_code == 200 and body["cited"] == [1] and body["unknown"] == [9] and body["cost_usd"] > 0
    sent = fake_claude.calls[-1][1]
    assert "[1] (notes, chunk 0)" in sent["messages"][0]["content"] and "only the numbered passages" in sent["system"]
    # nothing found: no model call at all
    empty = client.post("/api/vectordb/answer", headers=LAB, json={"collection": "empty", "query": "x"}).json()
    assert empty["passages"] == [] and empty["model"] is None and len(fake_claude.calls) == 1


def test_against_a_real_pgvector_when_one_is_running() -> None:
    db = PgVector("postgresql://lab:lab@127.0.0.1:5433/vectors", connect_timeout_s=1)
    if not db.status().get("running"):
        pytest.skip("No pgvector on 127.0.0.1:5433 (./tools/vector-db.sh starts one).")
    model, collection = f"test-{uuid.uuid4().hex[:8]}", "pytest"
    try:
        db.add(model, 3, collection, "doc", ["annual leave is 25 days", "blood tests in the morning", "pension"],
               [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
        found = db.search(model, 3, collection, "blood leave", [0.1, 0.9, 0], 2)
        assert [r["content"] for r in found["semantic"]["rows"]][0] == "blood tests in the morning"
        assert {r["content"] for r in found["keyword"]["rows"]} == {"annual leave is 25 days", "blood tests in the morning"}
        assert found["hybrid"]["rows"][0]["content"] == "blood tests in the morning"  # top in both lists
        assert "chunks_3" in found["plan"]
        # Row-level security, enforced by PostgreSQL: a reader outside the group never sees the row.
        db.add(model, 3, collection, "secret", ["salary bands"], [[0, 1, 0]], "hr", ["pay"])
        staff = db.search(model, 3, collection, "salary", [0, 1, 0], 5, ["everyone"])
        assert "salary bands" not in {r["content"] for r in staff["semantic"]["rows"]} and staff["hidden"] == 1
        hr = db.search(model, 3, collection, "salary", [0, 1, 0], 5, ["everyone", "hr"], ["pay"])
        assert [r["content"] for r in hr["semantic"]["rows"]] == ["salary bands"] and hr["hidden"] == 0
    finally:
        import psycopg

        with psycopg.connect(db.url) as conn:  # the 3-number table exists only for this test
            conn.execute("DROP TABLE IF EXISTS chunks_3")


def test_a_reader_sees_only_what_their_groups_allow_and_tags_filter(tmp_path: Path) -> None:
    store = FakeStore()
    client, _, _ = make(tmp_path, store)
    client.post("/api/vectordb/samples/handbook", headers=LAB)
    loaded = client.post("/api/vectordb/samples/restricted", headers=LAB).json()
    assert loaded["collection"] == "handbook" and loaded["documents"] == 2
    assert {r["access"] for r in store.rows} == {"everyone", "hr", "managers"}
    ask = {"collection": "handbook", "query": "leave salary", "k": 20}
    staff = client.post("/api/vectordb/search", headers=LAB, json={**ask, "reader": "Sam (staff)"}).json()
    assert store.last_groups == ["everyone"] and staff["hidden"] > 0
    assert not any("Salary" in r["source"] or "Restructure" in r["source"] for r in staff["semantic"]["rows"])
    hr = client.post("/api/vectordb/search", headers=LAB, json={**ask, "reader": "Priya (HR)"}).json()
    assert any(r["source"] == "Salary bands 2026" for r in hr["semantic"]["rows"])
    assert not any(r["source"].startswith("Restructure") for r in hr["semantic"]["rows"])
    tagged = client.post("/api/vectordb/search", headers=LAB, json={**ask, "reader": "Priya (HR)", "tags": ["pay"]}).json()
    assert {r["source"] for r in tagged["semantic"]["rows"]} == {"Salary bands 2026"}
    assert client.post("/api/vectordb/search", headers=LAB, json={**ask, "reader": "Mallory"}).status_code == 400
    assert client.post("/api/vectordb/search", headers=LAB, json={**ask, "tags": ["Not A Tag!"]}).status_code in (400, 422)
    bad = {"collection": "x", "source": "y", "text": "z", "access": "everybody"}
    assert client.post("/api/vectordb/documents", headers=LAB, json=bad).status_code == 400


def test_an_answer_for_a_reader_never_sees_their_hidden_chunks(tmp_path: Path) -> None:
    store = FakeStore()
    client, fake, _ = make(tmp_path, store, [[text("The handbook does not give pay [1].")]])
    client.post("/api/vectordb/samples/restricted", headers=LAB)
    client.post("/api/vectordb/documents", headers=LAB, json={"collection": "handbook", "source": "notes",
                                                                 "text": "## Pay\n\nPay is reviewed in April."})
    client.post("/api/vectordb/answer", headers=LAB, json={"collection": "handbook", "query": "salary", "k": 10,
                                                           "model": "claude-haiku-5-5", "reader": "Sam (staff)"})
    prompt = fake.calls[-1][1]["messages"][0]["content"]
    assert "reviewed in April" in prompt and "£70,000" not in prompt and "Leeds" not in prompt
