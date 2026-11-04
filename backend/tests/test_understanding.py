"""Content Understanding and vision with a fake gateway: analyzer and file pairing, custom analyzers made once,
field boxes, charges from the usage report, and structured vision output. No network."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services.understanding import boxes
from backend.app.settings import Settings
from backend.tests.test_api import LAB, FakeClient


class FakeTools:
    def __init__(self) -> None:
        self.puts: list[tuple[str, str]] = []
        self.analyzed: list[tuple[str, str]] = []

    def cu_put_analyzer(self, name: str, definition: dict, api_version: str = "2025-11-01") -> dict:
        self.puts.append((name, api_version))
        return {}

    def cu_analyze(self, analyzer: str, data: bytes, mime: str, timeout_s: float = 0, api_version: str = "") -> dict:
        self.analyzed.append((analyzer, mime))
        return {"contents": [{"kind": "document", "markdown": "# INVOICE", "unit": "pixel",
                              "pages": [{"width": 1240, "height": 1754, "words": [{}, {}]}],
                              "fields": {"Total": {"type": "number", "valueNumber": 480, "confidence": 0.9,
                                                   "source": "D(1,1,2,3,2,3,4,1,4)"}}}],
                "usage": {"documentPagesStandard": 1, "contextualizationTokens": 1000,
                          "tokens": {"gpt-4.1-mini-input": 4000, "gpt-4.1-mini-output": 200}}}

    def chat(self, model: str, messages: list[dict], **params: Any) -> dict:
        data = {"regions": [{"label": "stain", "box": [100, 100, 500, 400]}]}
        return {"choices": [{"message": {"content": json.dumps(data) if "response_format" in params else "A stained ceiling."}}],
                "usage": {"prompt_tokens": 1200, "completion_tokens": 40}}


def lab(tmp_path: Path, tools: Any) -> TestClient:
    settings = Settings(port=8000, budget_usd=2.0, frontend_dist=tmp_path, models_dir=tmp_path / "none", generated_dir=tmp_path / "gen")
    return TestClient(create_app(settings, client=FakeClient(), tools=tools), base_url="http://localhost:8000")


def test_boxes_parse_several_polygons() -> None:
    [a, b] = boxes("D(1,0,0,10,0,10,5,0,5);D(2,1,1,2,1,2,2,1,2)")
    assert a["page"] == 1 and a["points"][2] == [10.0, 5.0] and b["page"] == 2


def test_documents_are_drawn_on_demand_and_a_custom_analyzer_is_made_once(tmp_path: Path) -> None:
    tools = FakeTools()
    api = lab(tmp_path, tools)
    assert api.get("/api/understanding/media/invoice").content[:4] == b"\x89PNG"
    for _ in range(2):
        r = api.post("/api/understanding/analyze", json={"sample": "invoice", "analyzer": "labInvoice"}, headers=LAB).json()
    assert tools.puts == [("labInvoice", "2025-11-01")]
    assert r["fields"][0]["value"] == 480 and r["fields"][0]["boxes"][0]["page"] == 1 and r["words"] == 2
    assert 0.006 < r["cost_usd"] < 0.008  # a page, contextualization and gpt-4.1-mini tokens
    api.post("/api/understanding/analyze", json={"sample": "invoice", "analyzer": "labTotalsAgentic"}, headers=LAB)
    assert tools.puts[-1] == ("labTotalsAgentic", "2026-06-01-preview")


def test_an_analyzer_only_reads_its_own_kind_of_file(tmp_path: Path) -> None:
    api = lab(tmp_path, FakeTools())
    assert api.post("/api/understanding/analyze", json={"sample": "invoice", "analyzer": "prebuilt-videoSearch"}, headers=LAB).status_code == 400
    assert api.post("/api/understanding/analyze", json={"sample": "nope", "analyzer": "prebuilt-read"}, headers=LAB).status_code == 400
    assert api.get("/api/understanding/media/video").status_code == 404  # not made yet


def test_vision_tasks_return_structured_regions(tmp_path: Path) -> None:
    api = lab(tmp_path, FakeTools())
    r = api.post("/api/understanding/vision", json={"images": ["invoice"], "task": "regions"}, headers=LAB).json()
    assert r["data"]["regions"][0]["label"] == "stain" and r["cost_usd"] > 0
    assert api.post("/api/understanding/vision", json={"images": ["invoice"], "task": "poem"}, headers=LAB).status_code == 400
    assert lab(tmp_path, None).post("/api/understanding/analyze", json={"sample": "invoice", "analyzer": "prebuilt-read"},
                                    headers=LAB).status_code == 503
