"""Backend tests against a fake Claude client: no network, no API key, no cost.

    pytest backend
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from anthropic.types import Message
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.settings import Settings

LAB = {"x-llm-lab": "1", "host": "localhost:8000"}
HELLO = {"messages": [{"role": "user", "content": "Hello"}]}


def message(model: str, text: str = "Hi there", input_tokens: int = 1000, output_tokens: int = 200) -> Message:
    return Message.model_validate({
        "id": "msg_test", "type": "message", "role": "assistant", "model": model,
        "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": None,
        "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
    })


class FakeStream:
    def __init__(self, chunks: list[str], final: Message):
        self.text_stream, self._final = iter(chunks), final

    def __enter__(self) -> "FakeStream":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def get_final_message(self) -> Message:
        return self._final


class FakeMessages:
    def __init__(self, calls: list[tuple[str, dict]], endpoint: str):
        self.calls, self.endpoint = calls, endpoint

    def create(self, **params: Any) -> Message:
        self.calls.append((self.endpoint + ".create", params))
        return message(params["model"])

    def stream(self, **params: Any) -> FakeStream:
        self.calls.append((self.endpoint + ".stream", params))
        return FakeStream(["Hi", " there"], message(params["model"]))

    def count_tokens(self, **params: Any) -> Any:
        self.calls.append((self.endpoint + ".count_tokens", params))
        return type("Count", (), {"input_tokens": 42})()


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.messages = FakeMessages(self.calls, "messages")
        self.beta = type("Beta", (), {"messages": FakeMessages(self.calls, "beta.messages")})()
        self.models = type("Models", (), {"retrieve": lambda _self, model: {"id": model}})()


@pytest.fixture
def fake() -> FakeClient:
    return FakeClient()


def make_client(fake: FakeClient, tmp_path: Path, budget: float = 2.0) -> TestClient:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><div id=root></div>")
    (dist / "assets" / "app-abc123.js").write_text("console.log(1)")
    settings = Settings(port=8000, budget_usd=budget, frontend_dist=dist, models_dir=tmp_path / "no-models")
    return TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")


def test_status_reports_models_and_spend(fake: FakeClient, tmp_path: Path) -> None:
    body = make_client(fake, tmp_path).get("/api/status").json()
    assert body["ok"] and body["has_credentials"]
    assert body["default_model"] == "claude-haiku-5-5"
    assert body["models"][0] == "claude-haiku-5-5"
    assert body["spent_usd"] == 0 and body["calls"] == 0


def test_messages_uses_standard_endpoint_for_haiku_and_charges(fake: FakeClient, tmp_path: Path) -> None:
    client = make_client(fake, tmp_path)
    r = client.post("/api/messages", json={**HELLO, "max_tokens": 999999, "temperature": 1.0}, headers=LAB)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["message"]["content"][0]["text"] == "Hi there"
    endpoint, params = fake.calls[-1]
    assert endpoint == "messages.create"
    assert params["max_tokens"] == 16000            # capped for non-streaming requests
    assert "temperature" not in params             # unknown parameters are dropped
    assert data["cost_usd"] == pytest.approx((1000 * 0.10 + 200 * 0.50) / 1e6)
    assert client.get("/api/status").json()["calls"] == 1


def test_opus_goes_through_the_fallback_endpoint(fake: FakeClient, tmp_path: Path) -> None:
    r = make_client(fake, tmp_path).post("/api/messages", json={**HELLO, "model": "claude-opus-5-5"}, headers=LAB)
    assert r.status_code == 200
    endpoint, params = fake.calls[-1]
    assert endpoint == "beta.messages.create"
    assert params["fallbacks"] == "default"


def test_stream_returns_ndjson_text_then_done(fake: FakeClient, tmp_path: Path) -> None:
    r = make_client(fake, tmp_path).post("/api/stream", json=HELLO, headers=LAB)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ndjson")
    events = [json.loads(line) for line in r.text.splitlines() if line]
    assert [e["type"] for e in events] == ["text", "text", "done"]
    assert "".join(e["text"] for e in events[:2]) == "Hi there"
    assert {"ttft_ms", "total_ms"} <= set(events[-1]["timing"])


def test_count_tokens_needs_no_budget(fake: FakeClient, tmp_path: Path) -> None:
    client = make_client(fake, tmp_path, budget=0)
    r = client.post("/api/count_tokens", json=HELLO, headers=LAB)
    assert r.status_code == 200 and r.json() == {"input_tokens": 42}


@pytest.mark.parametrize("headers, why", [
    ({"host": "localhost:8000"}, "missing custom header"),
    ({"x-llm-lab": "1", "host": "evil.example:8000"}, "DNS rebinding"),
    ({"x-llm-lab": "1", "host": "localhost:8000", "origin": "https://evil.example"}, "another website"),
])
def test_calls_from_elsewhere_are_refused(fake: FakeClient, tmp_path: Path, headers: dict, why: str) -> None:
    r = make_client(fake, tmp_path).post("/api/messages", json=HELLO, headers=headers)
    assert r.status_code == 403, why
    assert r.json()["error"]["type"] == "forbidden"
    assert fake.calls == []


def test_vite_dev_server_origin_is_allowed(fake: FakeClient, tmp_path: Path) -> None:
    headers = {"x-llm-lab": "1", "host": "localhost:5173", "origin": "http://localhost:5173"}
    assert make_client(fake, tmp_path).post("/api/messages", json=HELLO, headers=headers).status_code == 200


def test_budget_stops_calls(fake: FakeClient, tmp_path: Path) -> None:
    r = make_client(fake, tmp_path, budget=0).post("/api/messages", json=HELLO, headers=LAB)
    assert r.status_code == 429 and r.json()["error"]["type"] == "budget_exceeded"
    assert fake.calls == []


@pytest.mark.parametrize("body", [{"messages": []}, {**HELLO, "model": "gpt-4"}, {"model": "claude-haiku-5-5"}])
def test_invalid_requests_get_a_readable_400(fake: FakeClient, tmp_path: Path, body: dict) -> None:
    r = make_client(fake, tmp_path).post("/api/messages", json=body, headers=LAB)
    assert r.status_code == 400
    assert r.json()["error"]["type"] == "invalid_request"
    assert fake.calls == []


def test_frontend_routes_fall_back_to_index(fake: FakeClient, tmp_path: Path) -> None:
    client = make_client(fake, tmp_path)
    page = client.get("/claude-code-inside")
    assert page.status_code == 200 and "id=root" in page.text
    assert page.headers["cache-control"] == "no-cache"
    asset = client.get("/assets/app-abc123.js")
    assert asset.status_code == 200 and "immutable" in asset.headers["cache-control"]
    assert client.get("/api/nope").status_code == 404
    assert client.get("/.env").status_code == 404                # never a dotfile
    assert client.get("/assets/missing-123.js").status_code == 404
    assert client.get("/models/gpt2-explainer/manifest.json").status_code == 404
    assert "id=root" in client.get("/agents.html").text            # old bookmark: the app redirects it
