"""Translation with a fake gateway: glossary markup per language, characters billed per target, schema output."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services.translate import with_glossary
from backend.app.settings import Settings
from backend.tests.test_api import LAB, FakeClient


class FakeTools:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[dict], dict]] = []

    def translator(self, route: str, body: list[dict], **params: Any) -> list[dict]:
        self.calls.append((route, body, params))
        targets = params["to"] if isinstance(params.get("to"), list) else [params.get("to")]
        return [{"detectedLanguage": {"language": "en", "score": 1.0},
                 "translations": [{"to": t, "text": f"[{t}] {body[0]['Text']}", "sentLen": {"transSentLen": [10]}} for t in targets]}]

    def chat(self, model: str, messages: list[dict], **params: Any) -> dict:
        content = json.dumps({"summary_english": "Late reply.", "language": "Spanish", "category": "delay", "tone": "angry",
                              "vulnerability_signals": [], "redress_requested": "a reply", "deadline_days": 56, "entities": []}) \
            if "response_format" in params else "Hola"
        return {"choices": [{"message": {"content": content}}], "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}


def lab(tmp_path: Path, tools: Any) -> TestClient:
    settings = Settings(port=8000, budget_usd=2.0, frontend_dist=tmp_path, models_dir=tmp_path / "none", generated_dir=tmp_path / "gen")
    return TestClient(create_app(settings, client=FakeClient(), tools=tools), base_url="http://localhost:8000")


def test_glossary_terms_are_wrapped_for_the_target_language() -> None:
    text, used = with_glossary("Your Escape of Water claim has an excess.", "fr")
    assert 'translation="dégât des eaux">Escape of Water<' in text and set(used) == {"escape of water", "excess"}
    assert with_glossary("No terms here.", "fr") == ("No terms here.", [])


def test_with_a_glossary_each_language_is_its_own_call_and_characters_are_billed_per_target(tmp_path: Path) -> None:
    tools = FakeTools()
    api = lab(tmp_path, tools)
    text = "The excess is £350."
    r = api.post("/api/translate/text", json={"text": text, "targets": ["es", "fr"], "glossary": True}, headers=LAB).json()
    assert len(tools.calls) == 2 and "mstrans:dictionary" in tools.calls[0][1][0]["Text"]
    assert r["chars_billed"] == 2 * len(text) and abs(r["cost_usd"] - 2 * len(text) * 10 / 1e6) < 1e-12
    api.post("/api/translate/text", json={"text": text, "targets": ["es", "fr"], "glossary": False}, headers=LAB)
    assert tools.calls[-1][2]["to"] == ["es", "fr"]  # one call for every language


def test_a_complaint_comes_back_as_a_log_entry(tmp_path: Path) -> None:
    r = lab(tmp_path, FakeTools()).post("/api/translate/complaint", json={"text": "Llevo tres semanas esperando."}, headers=LAB).json()
    assert r["entry"]["deadline_days"] == 56 and r["entry"]["category"] == "delay"
    assert lab(tmp_path, None).post("/api/translate/llm", json={"text": "x", "target": "es"}, headers=LAB).status_code == 503
