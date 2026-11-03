"""The review dashboard with a fake Azure Language and a fake Claude: the pipeline, batching, charges and reuse. No network."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.app.gateways.azure_language import AzureLanguage
from backend.app.main import create_app
from backend.app.services.review_samples import REVIEWS
from backend.app.settings import Settings
from backend.tests.test_api import LAB, FakeClient, message

READING = {"language": {"name": "German", "iso": "de"}, "sentiment": "mixed", "key_phrases": ["Akku"],
           "key_phrases_english": ["battery"], "entities": [{"text": "Ardent", "category": "Brand"}],
           "opinions": [{"target": "Akku", "assessment": "hält lange", "sentiment": "positive"}], "english": "..."}


class FakeLanguage:
    """Answers like Azure Language: Chinese is detected as zh_chs, everything else as German."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[dict], dict | None]] = []

    def analyze(self, kind: str, documents: list[dict], parameters: dict | None = None) -> dict:
        self.calls.append((kind, documents, parameters))
        out = []
        for d in documents:
            if kind == "LanguageDetection":
                chinese = any("一" <= ch <= "鿿" for ch in d["text"])
                out.append({"id": d["id"], "warnings": [], "detectedLanguage": {
                    "name": "Chinese_Simplified" if chinese else "German", "iso6391Name": "zh_chs" if chinese else "de",
                    "confidenceScore": 1.0, "scriptName": "Latin"}})
            elif kind == "SentimentAnalysis":
                out.append({"id": d["id"], "warnings": [], "sentiment": "positive",
                            "confidenceScores": {"positive": 0.9, "neutral": 0.1, "negative": 0.0},
                            "sentences": [{"text": d["text"], "sentiment": "positive",
                                           "confidenceScores": {"positive": 0.9, "neutral": 0.1, "negative": 0.0},
                                           "targets": [{"text": "Akku", "sentiment": "positive", "relations": [
                                               {"relationType": "assessment", "ref": "#/documents/0/sentences/0/assessments/0"}]}],
                                           "assessments": [{"text": "lange", "sentiment": "positive", "isNegated": False}]}]})
            elif kind == "KeyPhraseExtraction":
                out.append({"id": d["id"], "warnings": [], "keyPhrases": ["Akku"]})
            else:
                out.append({"id": d["id"], "warnings": [], "entities": [
                    {"text": "Ardent", "category": "Organization", "confidenceScore": 0.9}]})
        return {"documents": out, "errors": [], "model_version": "2026-05-01", "requests": 1}


def lab(tmp_path: Path, language: FakeLanguage | None, fake: FakeClient | None = None, budget: float = 2.0) -> TestClient:
    settings = Settings(port=8000, budget_usd=budget, frontend_dist=tmp_path, models_dir=tmp_path / "none",
                        sites_dir=tmp_path / "sites", casework_dir=tmp_path / "casework")
    return TestClient(create_app(settings, client=fake or FakeClient(), language=language), base_url="http://localhost:8000")


def test_detects_first_then_sends_each_language_and_charges_text_records(tmp_path: Path) -> None:
    language = FakeLanguage()
    client = lab(tmp_path, language)
    r = client.post("/api/reviews/analyze", json={"ids": ["R01", "R02"]}, headers=LAB)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [c[0] for c in language.calls][0] == "LanguageDetection"
    sent = {d["id"]: d["language"] for d in next(c[1] for c in language.calls if c[0] == "KeyPhraseExtraction")}
    assert sent == {"R01": "zh-hans", "R02": "de"}  # detection's zh_chs is not a code the other features accept
    assert next(c[2] for c in language.calls if c[0] == "SentimentAnalysis") == {"opinionMining": True}
    assert body["records"] == 2 * 4 and abs(body["cost_usd"] - 0.008) < 1e-9
    r01 = body["analyses"]["R01"]
    assert r01["language"]["name"] == "Chinese Simplified" and r01["sent_as"] == "zh-hans"
    assert r01["sentiment"]["sentences"][0]["opinions"] == [
        {"target": "Akku", "sentiment": "positive", "assessments": [{"text": "lange", "sentiment": "positive", "negated": False}]}]
    assert r01["entities"][0]["category"] == "Organization"
    assert client.get("/api/status").json()["spent_usd"] == body["cost_usd"]


def test_the_same_text_is_never_paid_for_twice(tmp_path: Path) -> None:
    language = FakeLanguage()
    client = lab(tmp_path, language)
    client.post("/api/reviews/analyze", json={"ids": ["R02"]}, headers=LAB)
    calls = len(language.calls)
    again = client.post("/api/reviews/analyze", json={"ids": ["R02"]}, headers=LAB).json()
    assert len(language.calls) == calls and again["cost_usd"] == 0 and again["reused"] == 1
    everything = client.post("/api/reviews/analyze", json={}, headers=LAB).json()
    assert everything["analysed"] == len(REVIEWS) - 1 and len(everything["analyses"]) == len(REVIEWS)
    assert set(client.get("/api/reviews/info", headers=LAB).json()["analysed"]) == {r["id"] for r in REVIEWS}


def test_a_pasted_review_is_analysed_and_a_long_one_bills_more_records(tmp_path: Path) -> None:
    client = lab(tmp_path, FakeLanguage())
    body = client.post("/api/reviews/analyze", json={"text": "Der Akku hält lange. " * 60}, headers=LAB).json()
    [(rid, _)] = body["analyses"].items()
    assert rid.startswith("custom-") and body["records"] == 2 * 4  # 1,260 characters: two records per feature


def test_unconfigured_unknown_and_over_budget_are_refused(tmp_path: Path) -> None:
    assert lab(tmp_path, None).post("/api/reviews/analyze", json={}, headers=LAB).status_code == 503
    assert lab(tmp_path, FakeLanguage()).post("/api/reviews/analyze", json={"ids": ["R99"]}, headers=LAB).status_code == 404
    assert lab(tmp_path, FakeLanguage(), budget=0).post("/api/reviews/analyze", json={}, headers=LAB).status_code == 429
    assert lab(tmp_path, FakeLanguage()).post("/api/reviews/analyze", json={}).status_code == 403  # not from a lab page


def test_claude_reads_the_same_review_once_per_model(tmp_path: Path) -> None:
    fake = FakeClient()
    fake.messages.create = lambda **p: (fake.calls.append(("messages.create", p)),  # type: ignore[method-assign]
                                        message(p["model"], json.dumps(READING)))[1]
    client = lab(tmp_path, FakeLanguage(), fake)
    first = client.post("/api/reviews/compare", json={"id": "R28"}, headers=LAB).json()
    assert first["reading"]["key_phrases_english"] == ["battery"] and first["cost_usd"] > 0 and not first["reused"]
    _, params = fake.calls[-1]
    assert params["output_config"]["format"]["type"] == "json_schema" and "Ardent Ultrabook" in params["messages"][0]["content"]
    again = client.post("/api/reviews/compare", json={"id": "R28"}, headers=LAB).json()
    assert again["reused"] and len(fake.calls) == 1
    bad = client.post("/api/reviews/compare", json={"id": "R28", "model": "gpt-4"}, headers=LAB)
    assert bad.status_code == 400


def test_the_gateway_splits_documents_at_each_features_limit(monkeypatch: Any) -> None:
    gateway = AzureLanguage("https://example.cognitiveservices.azure.com")
    sizes: list[int] = []

    def request(kind: str, documents: list[dict], parameters: dict | None) -> dict:
        sizes.append(len(documents))
        return {"documents": documents, "errors": [], "modelVersion": "v"}

    monkeypatch.setattr(gateway, "_request", request)
    docs = [{"id": str(i), "text": "x"} for i in range(12)]
    assert gateway.analyze("EntityRecognition", docs)["requests"] == 3 and sorted(sizes) == [2, 5, 5]
    sizes.clear()
    assert gateway.analyze("LanguageDetection", docs)["requests"] == 1 and sizes == [12]
