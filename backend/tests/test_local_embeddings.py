"""The local embedding model: the gateway against a fake server, then the route with a fake gateway. No network."""
from __future__ import annotations

import math
import urllib.error
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.api import deps
from backend.app.gateways.local_embeddings import LocalEmbeddings, LocalEmbeddingsUnavailable, prefix_for
from backend.app.main import create_app
from backend.app.settings import Settings
from backend.tests.test_api import LAB
from backend.tests.test_aftercare import ScriptedClient

URL = "http://localhost:12434/engines/v1"


class FakeServer:
    """Stands in for Docker Model Runner: records what was posted and answers with one vector per text."""

    def __init__(self, models: list[str] | None = None, fail: Exception | None = None):
        self.models = models if models is not None else ["docker.io/ai/nomic-embed-text-v1.5:latest"]
        self.fail, self.posts = fail, []

    def post(self, url: str, body: dict, timeout_s: float) -> dict:
        if self.fail:
            raise self.fail
        self.posts.append((url, body))
        # out of order on purpose: the gateway must sort by index
        rows = [{"index": i, "embedding": [3.0, 4.0, float(i)]} for i in range(len(body["input"]))]
        return {"data": list(reversed(rows))}

    def get(self, url: str, timeout_s: float) -> dict:
        if self.fail:
            raise self.fail
        return {"data": [{"id": m} for m in self.models]}


def test_texts_get_the_models_prefix_and_vectors_come_back_unit_length_in_order() -> None:
    server = FakeServer()
    embedder = LocalEmbeddings("ai/nomic-embed-text-v1.5", URL, post=server.post, get=server.get)
    vectors = embedder.embed(["a cat", "a dog"], "query")
    url, body = server.posts[0]
    assert url == f"{URL}/embeddings" and body["model"] == "ai/nomic-embed-text-v1.5"
    assert body["input"] == ["search_query: a cat", "search_query: a dog"]
    assert vectors[0] == [0.6, 0.8, 0.0] and vectors[1][2] > 0  # sorted by index, scaled to length 1
    assert all(math.isclose(sum(x * x for x in v), 1.0) for v in vectors)
    embedder.embed(["stored passage"])
    assert server.posts[1][1]["input"] == ["search_document: stored passage"]


def test_many_texts_are_sent_in_batches() -> None:
    server = FakeServer()
    embedder = LocalEmbeddings("ai/some-other-model", URL, post=server.post, get=server.get)
    assert len(embedder.embed([f"text {i}" for i in range(70)])) == 70
    assert [len(body["input"]) for _, body in server.posts] == [32, 32, 6]
    assert server.posts[0][1]["input"][0] == "text 0"  # a model we do not know gets no prefix


def test_prefixes_by_model_family() -> None:
    assert prefix_for("ai/nomic-embed-text-v1.5", "document") == "search_document: "
    assert prefix_for("ai/mxbai-embed-large", "document") == ""
    assert prefix_for("ai/mxbai-embed-large", "query").startswith("Represent this sentence")
    assert prefix_for("ai/qwen3-embedding", "query") == ""


def test_status_says_what_is_missing_and_never_raises() -> None:
    assert LocalEmbeddings("", URL).status() == {"configured": False}
    up = FakeServer()
    assert LocalEmbeddings("ai/nomic-embed-text-v1.5", URL, post=up.post, get=up.get).status() == {
        "configured": True, "running": True, "has_model": True, "model": "ai/nomic-embed-text-v1.5"}
    other = FakeServer(models=["docker.io/ai/qwen3.5:9b-q4_K_XL"])
    assert LocalEmbeddings("ai/nomic-embed-text-v1.5", URL, post=other.post, get=other.get).status()["has_model"] is False
    down = FakeServer(fail=urllib.error.URLError("refused"))
    assert LocalEmbeddings("ai/nomic-embed-text-v1.5", URL, post=down.post, get=down.get).status()["running"] is False


def test_failures_explain_what_to_do() -> None:
    with pytest.raises(LocalEmbeddingsUnavailable, match="local-model.sh --embed"):
        LocalEmbeddings("", URL).embed(["x"])
    down = FakeServer(fail=urllib.error.URLError("refused"))
    with pytest.raises(LocalEmbeddingsUnavailable, match="did not answer"):
        LocalEmbeddings("ai/nomic-embed-text-v1.5", URL, post=down.post, get=down.get).embed(["x"])


class FakeEmbedder:
    model = "ai/fake-embed"

    def __init__(self) -> None:
        self.calls: list[tuple[list[str], str]] = []

    def status(self) -> dict[str, Any]:
        return {"configured": True, "running": True, "has_model": True, "model": self.model}

    def embed(self, texts: list[str], kind: str = "document") -> list[list[float]]:
        self.calls.append((texts, kind))
        return [[1.0, 0.0] for _ in texts]


def test_the_route_is_guarded_capped_and_free(tmp_path: Path) -> None:
    settings = Settings(port=8000, budget_usd=0.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    app = create_app(settings, client=ScriptedClient([]))
    client = TestClient(app, base_url="http://localhost:8000")
    # not set up: the info route says so, and embedding explains what to do
    assert client.get("/api/embeddings/local", headers=LAB).json() == {"configured": False}
    refused = client.post("/api/embeddings/local", headers=LAB, json={"texts": ["x"]})
    assert refused.status_code == 503 and "LLM_LAB_LOCAL_EMBED_MODEL" in refused.json()["error"]["message"]

    fake = FakeEmbedder()
    app.dependency_overrides[deps.local_embeddings] = lambda: fake
    r = client.post("/api/embeddings/local", headers=LAB, json={"texts": ["a", "b"], "kind": "query"})
    assert r.status_code == 200  # works with no budget left: it costs nothing
    assert r.json() == {"model": "ai/fake-embed", "dims": 2, "vectors": [[1.0, 0.0], [1.0, 0.0]]}
    assert fake.calls == [(["a", "b"], "query")]
    assert client.get("/api/embeddings/local", headers=LAB).json()["has_model"] is True
    # the guards and the caps
    assert client.post("/api/embeddings/local", json={"texts": ["a"]}).status_code in (400, 403)
    assert client.post("/api/embeddings/local", headers=LAB, json={"texts": []}).status_code in (400, 422)
    assert client.post("/api/embeddings/local", headers=LAB, json={"texts": ["x"] * 129}).status_code in (400, 422)
    assert client.post("/api/embeddings/local", headers=LAB, json={"texts": ["x" * 4001]}).status_code in (400, 422)
    assert client.post("/api/embeddings/local", headers=LAB, json={"texts": ["x"], "kind": "essay"}).status_code in (400, 422)
