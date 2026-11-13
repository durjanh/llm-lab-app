"""GraphRAG: merging entities, finding communities, building and asking, with a fake model, fake database and fake
embedder, so no Docker and no cost. A last test runs the graph tables against a real pgvector when one is running."""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.api import deps
from backend.app.gateways.claude import ClaudeGateway
from backend.app.gateways.graph_store import PgGraph, walk_sql
from backend.app.gateways.pgvector import PgVector
from backend.app.main import create_app
from backend.app.services.graphrag import GraphRagService, estimate, louvain, merge, normalise
from backend.app.services.runs import RunRegistry, RunStreamer
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB
from backend.tests.test_vectordb import FakeEmbedder, FakeStore

HAIKU = "claude-haiku-5-5"


def ref(source: str, chunk: int) -> dict[str, Any]:
    return {"source": source, "chunk": chunk}


def test_names_are_normalised_so_mentions_merge() -> None:
    assert normalise("The Kestrel Components.") == normalise("kestrel  components") == "kestrel components"
    assert normalise("R&D team") == "r&d team"


def test_the_same_entity_from_two_chunks_is_merged_and_a_missing_endpoint_is_added() -> None:
    a = {"entities": [{"name": "Priya Shah", "type": "person", "description": "Head of engineering."},
                      {"name": "Project Heron", "type": "project", "description": "A picking robot."}],
         "relationships": [{"source": "Priya Shah", "target": "Project Heron", "description": "Leads the fix.",
                            "strength": 8}]}
    b = {"entities": [{"name": "priya shah", "type": "person", "description": "Wrote the motor memo."},
                      {"name": "Project Heron", "type": "product", "description": "A picking robot."}],
         "relationships": [{"source": "Project Heron", "target": "Priya Shah", "description": "Fix led by her.",
                            "strength": 12},
                           {"source": "Priya Shah", "target": "Kestrel Components", "description": "Asked for a plan.",
                            "strength": 5},
                           {"source": "Priya Shah", "target": "Priya Shah", "description": "self", "strength": 3}]}
    entities, relations = merge([(ref("m", 0), a), (ref("m", 1), b)])
    by = {e["key"]: e for e in entities}
    assert set(by) == {"priya shah", "project heron", "kestrel components"}
    assert by["priya shah"]["name"] in ("Priya Shah", "priya shah")
    assert by["priya shah"]["description"] == "Head of engineering. Wrote the motor memo."
    assert by["priya shah"]["refs"] == [ref("m", 0), ref("m", 1)]
    assert by["project heron"]["type"] == "project"  # a tie goes to the first type given
    assert by["kestrel components"]["type"] == "other" and "plan" in by["kestrel components"]["description"]
    pair = next(r for r in relations if {r["source"], r["target"]} == {"priya shah", "project heron"})
    assert pair["strength"] == 10 and "Leads the fix." in pair["description"]  # one relation per pair, capped at 10
    assert len(relations) == 2  # the self-loop is dropped


def test_louvain_finds_two_clusters_joined_by_one_weak_link_and_is_deterministic() -> None:
    left = ["a", "b", "c", "d"]
    right = ["w", "x", "y", "z"]
    edges = [(p, q, 5.0) for group in (left, right) for i, p in enumerate(group) for q in group[i + 1:]]
    edges.append(("d", "w", 1.0))
    nodes = left + right + ["lonely"]
    first = louvain(nodes, edges)
    assert first == louvain(list(reversed(nodes)), list(reversed(edges)))
    assert len({first[n] for n in left}) == 1 and len({first[n] for n in right}) == 1
    assert first["a"] != first["w"] and first["lonely"] not in (first["a"], first["w"])
    assert sorted(set(first.values())) == [0, 1, 2]  # numbered by size, largest first
    assert louvain(["p", "q"], []) == {"p": 0, "q": 1}


def test_the_estimate_counts_calls_and_caps_chunks() -> None:
    small = estimate(9, HAIKU)
    assert small["used"] == 9 and small["calls"] == 9 + 3 and 0 < small["cost_usd"] < 0.05
    big = estimate(500, HAIKU)
    assert big["capped"] and big["used"] == 40 and big["calls"] == 52


class FakeGraph:
    """An in-memory stand-in for PgGraph, reading chunks from the fake vector store."""

    def __init__(self, store: FakeStore) -> None:
        self.store = store
        self.saved: dict[str, Any] = {}

    def collections(self, model: str, dims: int) -> list[dict[str, Any]]:
        names = sorted({r["collection"] for r in self.store.rows})
        return [{"collection": n, "chunks": sum(r["collection"] == n for r in self.store.rows), "documents": 1,
                 "entities": len(self.saved.get(n, {}).get("entities", [])), "relations": 0, "communities": 0,
                 "built": None} for n in names]

    def chunks(self, model: str, dims: int, collection: str, limit: int) -> list[dict[str, Any]]:
        rows = [r for r in self.store.rows if r["collection"] == collection]
        return [{"source": r["source"], "chunk": r["chunk"], "content": r["content"]} for r in rows][:limit]

    def chunk_texts(self, model: str, dims: int, collection: str, refs: list[tuple[str, int]]) -> list[dict[str, Any]]:
        rows = {(r["source"], r["chunk"]): r["content"] for r in self.store.rows if r["collection"] == collection}
        return [{"source": s, "chunk": n, "content": rows[(s, n)]} for s, n in refs if (s, n) in rows]

    def replace(self, model: str, dims: int, collection: str, entities: list, relations: list, communities: list) -> None:
        self.saved[collection] = {"entities": entities, "relations": relations, "communities": communities}

    def graph(self, model: str, dims: int, collection: str) -> dict[str, Any]:
        g = self.saved.get(collection, {"entities": [], "relations": [], "communities": []})
        return {"entities": [{k: v for k, v in e.items() if k != "vector"} for e in g["entities"]],
                "relations": g["relations"], "communities": g["communities"]}

    def nearest(self, model: str, dims: int, collection: str, vector: list[float], k: int) -> list[dict[str, Any]]:
        ents = self.saved.get(collection, {}).get("entities", [])
        scored = sorted(ents, key=lambda e: -sum(a * b for a, b in zip(e["vector"], vector)))[:k]
        return [{**{x: e[x] for x in ("key", "name", "type", "description", "refs", "community")}, "similarity": 0.9}
                for e in scored]

    def walk(self, model: str, dims: int, collection: str, seeds: list[str], hops: int, limit: int) -> dict[str, Any]:
        rels = self.saved.get(collection, {}).get("relations", [])
        reached = {s: 0 for s in seeds}
        for hop in range(1, hops + 1):
            for r in rels:
                for a, b in ((r["source"], r["target"]), (r["target"], r["source"])):
                    if a in reached and reached[a] == hop - 1 and b not in reached:
                        reached[b] = hop
        inside = [r for r in rels if r["source"] in reached and r["target"] in reached][:limit]
        return {"reached": reached, "relations": inside}


EXTRACTION = {"entities": [{"name": "Blood tests", "type": "policy", "description": "Taken in the morning."},
                           {"name": "Practice nurse", "type": "person", "description": "Takes blood."}],
              "relationships": [{"source": "Practice nurse", "target": "Blood tests", "description": "Takes them.",
                                 "strength": 9}]}


def make(tmp_path: Path, script: list) -> tuple[TestClient, ScriptedClient, FakeStore, FakeGraph]:
    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    fake = ScriptedClient(script)
    app = create_app(settings, client=fake)
    store = FakeStore()
    graph = FakeGraph(store)
    spend = SpendTracker(1.0)
    service = GraphRagService(store, graph, FakeEmbedder(), ClaudeGateway(fake), spend,
                              RunStreamer(RunRegistry(), 5.0), workers=1)
    app.dependency_overrides[deps.graphrag] = lambda: service
    return TestClient(app, base_url="http://localhost:8000"), fake, store, graph


def test_a_build_streams_its_steps_and_saves_the_graph_then_all_three_searches_answer(tmp_path: Path) -> None:
    script = [[text(json.dumps(EXTRACTION))], [text(json.dumps(EXTRACTION))],
              [text(json.dumps({"title": "Blood tests", "summary": "The nurse takes blood tests in the morning."}))],
              # vector, local, then global (one map call per community, then the answer)
              [text("In the morning [1].")],
              [text("The practice nurse [2], see [9].")],
              [text(json.dumps({"points": [{"text": "The nurse takes blood in the morning.", "importance": 80}]}))],
              [text("Mornings, by the nurse [1].")]]
    client, fake, store, graph = make(tmp_path, script)
    doc = "## Blood\n\nBlood tests are taken by the practice nurse in the morning.\n\n## Fast\n\nFast only if told to."
    store.add("ai/fake-embed", 7, "clinic", "guide", ["## Blood\nBlood tests by the nurse.", "## Fast\nFast blood."],
              FakeEmbedder().embed([doc, doc]))

    status = client.get("/api/graphrag/status", headers=LAB, params={"model": HAIKU}).json()
    assert status["collections"][0]["collection"] == "clinic" and status["collections"][0]["estimate"]["calls"] == 3

    with client.stream("POST", "/api/graphrag/build", headers=LAB, json={"collection": "clinic", "model": HAIKU}) as r:
        events = [json.loads(line) for line in r.iter_lines() if line.strip()]
    kinds = [e["type"] for e in events]
    assert kinds[0] == "run" and kinds.count("chunk") == 2 and "merged" in kinds and kinds[-1] == "done"
    merged = next(e for e in events if e["type"] == "merged")
    assert merged == {"type": "merged", "mentions": 4, "entities": 2, "relations": 1}
    assert events[-1]["communities"] == 1 and events[-1]["cost_usd"] > 0
    saved = graph.saved["clinic"]
    assert {e["key"] for e in saved["entities"]} == {"blood tests", "practice nurse"}
    assert all(len(e["vector"]) == 7 and e["community"] == 0 for e in saved["entities"])

    vector = client.post("/api/graphrag/ask", headers=LAB,
                         json={"collection": "clinic", "question": "blood", "mode": "vector", "model": HAIKU}).json()
    assert vector["cited"] == [1] and vector["evidence"][0]["kind"] == "chunk"
    assert set(vector["highlight"]["entities"]) == {"blood tests", "practice nurse"}

    local = client.post("/api/graphrag/ask", headers=LAB,
                        json={"collection": "clinic", "question": "nurse", "mode": "local", "model": HAIKU}).json()
    assert local["unknown"] == [9] and {e["kind"] for e in local["evidence"]} == {"entity", "relation", "chunk"}
    assert "WITH RECURSIVE" in local["sql"]

    glob = client.post("/api/graphrag/ask", headers=LAB,
                       json={"collection": "clinic", "question": "themes", "mode": "global", "model": HAIKU}).json()
    assert glob["mapped"] == 1 and glob["highlight"]["communities"] == [0] and glob["cited"] == [1]
    assert glob["evidence"][0]["kind"] == "community"
    assert not fake.script  # every scripted reply was used: nothing extra was called


def test_asking_before_a_build_and_bad_input_get_clear_errors(tmp_path: Path) -> None:
    client, _, store, _ = make(tmp_path, [])
    store.add("ai/fake-embed", 7, "clinic", "guide", ["blood"], FakeEmbedder().embed(["blood"]))
    r = client.post("/api/graphrag/ask", headers=LAB, json={"collection": "clinic", "question": "x", "mode": "global"})
    assert r.status_code == 409 and "Build the graph" in r.json()["error"]["message"]
    r = client.post("/api/graphrag/ask", headers=LAB, json={"collection": "clinic", "question": "x", "mode": "local"})
    assert r.status_code == 409
    assert client.post("/api/graphrag/ask", headers=LAB,
                       json={"collection": "clinic", "question": "x", "mode": "other"}).status_code in (400, 422)
    assert client.post("/api/graphrag/build", headers=LAB, json={"collection": "none"}).status_code == 404
    assert client.post("/api/graphrag/build", json={"collection": "clinic"}).status_code in (400, 403)
    assert client.post("/api/graphrag/ask", headers=LAB,
                       json={"collection": "a;b", "question": "x", "mode": "vector"}).status_code in (400, 422)


def test_the_sample_loads_into_the_vector_database(tmp_path: Path) -> None:
    client, _, store, _ = make(tmp_path, [])
    r = client.post("/api/graphrag/sample", headers=LAB).json()
    assert r["collection"] == "quillmere" and r["documents"] == 5 and r["chunks"] >= 5
    assert {row["collection"] for row in store.rows} == {"quillmere"}


def test_graph_tables_against_a_real_pgvector_when_one_is_running() -> None:
    db = PgVector("postgresql://lab:lab@127.0.0.1:5433/vectors", connect_timeout_s=1)
    if not db.status().get("running"):
        pytest.skip("No pgvector on 127.0.0.1:5433 (./tools/vector-db.sh starts one).")
    graph = PgGraph(db)
    model, collection = f"test-{uuid.uuid4().hex[:8]}", "pytest"
    ents = [{"key": k, "name": k.title(), "type": "person", "description": f"{k} desc", "refs": [ref("d", 0)],
             "degree": 1, "community": 0, "vector": v}
            for k, v in (("ann", [1, 0, 0]), ("bob", [0, 1, 0]), ("cat", [0, 0, 1]))]
    rels = [{"source": "ann", "target": "bob", "description": "works with", "strength": 8.0, "refs": [ref("d", 0)]},
            {"source": "bob", "target": "cat", "description": "manages", "strength": 5.0, "refs": [ref("d", 0)]}]
    try:
        graph.replace(model, 3, collection, ents, rels, [{"community": 0, "title": "T", "summary": "S",
                                                         "members": ["ann", "bob", "cat"]}])
        assert graph.nearest(model, 3, collection, [0.9, 0.1, 0], 1)[0]["key"] == "ann"
        walked = graph.walk(model, 3, collection, ["ann"], 2, 10)
        assert walked["reached"] == {"ann": 0, "bob": 1, "cat": 2} and len(walked["relations"]) == 2
        assert graph.walk(model, 3, collection, ["ann"], 1, 10)["reached"] == {"ann": 0, "bob": 1}
        got = graph.graph(model, 3, collection)
        assert len(got["entities"]) == 3 and got["communities"][0]["members"] == ["ann", "bob", "cat"]
        assert "WITH RECURSIVE" in walk_sql(3)
    finally:
        import psycopg

        with psycopg.connect(db.url) as conn:  # the 3-number tables exist only for this test
            for t in ("graph_entities_3", "graph_relations_3", "graph_communities_3", "chunks_3"):
                conn.execute(f"DROP TABLE IF EXISTS {t}")
