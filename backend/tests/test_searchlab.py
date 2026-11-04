"""The search pipeline with fakes: chunking, every step reported, the four query bodies, scoring, the agent's tool loop."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services import search_samples as samples
from backend.app.services.searchlab import chunks
from backend.app.settings import Settings
from backend.tests.test_api import LAB, FakeClient
from backend.tests.test_understanding import FakeTools as UnderstandingTools


class Tools(UnderstandingTools):
    def language(self, kind: str, documents: list[dict], parameters: Any = None) -> list[dict]:
        return [{"id": d["id"], "keyPhrases": ["water"]} for d in documents]

    def embed(self, texts: list[str], model: str = "") -> tuple[list[list[float]], int]:
        return [[0.1] * 1536 for _ in texts], 10 * len(texts)

    def chat(self, model: str, messages: list[dict], **params: Any) -> dict:
        if params.get("tools") and messages[-1]["role"] == "user":
            return {"choices": [{"message": {"content": None, "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "search_claim_file", "arguments": json.dumps({"query": "leak"})}}]}}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 10}}
        return {"choices": [{"message": {"content": "Covered [policy-escape]."}}], "usage": {"prompt_tokens": 200, "completion_tokens": 20}}


class FakeSearch:
    """Ranks the expected source first for keyword queries that contain 'KD-20419', else returns policy-escape."""
    def __init__(self) -> None:
        self.bodies: list[dict] = []
        self.indexes: set[str] = set()

    def index_exists(self, name: str) -> bool:
        return name in self.indexes

    def delete_index(self, name: str) -> None:
        self.indexes.discard(name)

    def create_index(self, definition: dict) -> None:
        self.indexes.add(definition["name"])

    def upload(self, index: str, docs: list[dict]) -> None:
        self.docs = docs

    def search(self, index: str, body: dict) -> dict:
        self.bodies.append(body)
        top = "doc-invoice" if "KD-20419" in body.get("search", "") else "policy-escape"
        return {"value": [{"id": f"{top}-0", "source": top, "title": "t", "modality": "text", "chunk": "c", "@search.score": 1.0}]}

    def index_stats(self, name: str) -> dict:
        return {"documentCount": len(getattr(self, "docs", []))}

    def service_stats(self) -> dict:
        return {"counters": {"indexesCount": {"usage": 1, "quota": 3}}}


def lab(tmp_path: Path, search: Any) -> TestClient:
    settings = Settings(port=8000, budget_usd=2.0, frontend_dist=tmp_path, models_dir=tmp_path / "none", generated_dir=tmp_path / "gen")
    return TestClient(create_app(settings, client=FakeClient(), tools=Tools(), search=search), base_url="http://localhost:8000")


def test_chunks_pack_paragraphs_and_overlap() -> None:
    parts = chunks("\n\n".join(["a" * 500, "b" * 500, "c" * 500]), size=900, overlap=50)
    assert len(parts) == 3 and parts[1].startswith("a" * 50)


def test_ingest_reports_every_step_and_builds_the_index(tmp_path: Path) -> None:
    search = FakeSearch()
    r = lab(tmp_path, search).post("/api/searchlab/ingest", headers=LAB).json()
    assert [s["step"].split(" ")[0] for s in r["steps"]] == ["Extract", "Chunk", "Enrich:", "Embed", "Index"]
    assert "lab-claims" in search.indexes and all(len(d["contentVector"]) == 1536 for d in search.docs)
    assert {d["source"] for d in search.docs} >= {p[0] for p in samples.POLICY}
    assert r["cost_usd"] > 0


def test_each_mode_sends_the_right_query_and_the_evaluation_scores_ranks(tmp_path: Path) -> None:
    search = FakeSearch()
    api = lab(tmp_path, search)
    api.post("/api/searchlab/query", json={"text": "leak", "mode": "keyword"}, headers=LAB)
    api.post("/api/searchlab/query", json={"text": "leak", "mode": "semantic"}, headers=LAB)
    assert "vectorQueries" not in search.bodies[0] and search.bodies[1]["queryType"] == "semantic"
    e = api.post("/api/searchlab/evaluate", headers=LAB).json()
    first = sum(1 for _, expect in samples.QUERIES if expect == "policy-escape")
    assert e["summary"]["vector"]["hit1"] == first and e["summary"]["keyword"]["hit1"] == first + 1  # the invoice number


def test_the_agent_searches_then_answers_with_a_citation(tmp_path: Path) -> None:
    r = lab(tmp_path, FakeSearch()).post("/api/searchlab/ask", json={"question": "Am I covered?"}, headers=LAB).json()
    assert r["steps"] == [{"query": "leak", "sources": ["policy-escape"]}] and "[policy-escape]" in r["answer"]
