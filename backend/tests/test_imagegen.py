"""Image generation with a fake gateway: saving, provenance, the rate limit waited out, masks resized, charges."""
from __future__ import annotations

import base64
import io
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app.core.errors import ApiError
from backend.app.main import create_app
from backend.app.services import imagegen as imagegen_module
from backend.app.settings import Settings
from backend.tests.test_api import LAB, FakeClient


def png(size: tuple[int, int] = (64, 48), c2pa: bool = True) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, "white").save(buf, "PNG")
    return buf.getvalue() + (b"caBXjumbc2pa" if c2pa else b"")


class FakeTools:
    media_endpoint = "https://media.example"

    def __init__(self, busy: int = 0) -> None:
        self.busy, self.edits = busy, []

    def generate_image(self, prompt: str, **params: Any) -> dict:
        if self.busy:
            self.busy -= 1
            raise ApiError(429, "rate_limited", "gpt-image-2 is rate limiting this deployment: retry after 0 s.")
        return {"data": [{"b64_json": base64.b64encode(png()).decode()}] * params.get("n", 1),
                "usage": {"input_tokens": 20, "input_tokens_details": {"text_tokens": 20, "image_tokens": 0}, "output_tokens": 1000}}

    def edit_image(self, prompt: str, images: list[bytes], mask: bytes | None = None, **params: Any) -> dict:
        self.edits.append((images, mask))
        return {"data": [{"b64_json": base64.b64encode(png()).decode()}],
                "usage": {"input_tokens": 300, "input_tokens_details": {"text_tokens": 20, "image_tokens": 280}, "output_tokens": 1000}}


def lab(tmp_path: Path, tools: Any) -> TestClient:
    settings = Settings(port=8000, budget_usd=2.0, frontend_dist=tmp_path, models_dir=tmp_path / "none", generated_dir=tmp_path / "gen")
    return TestClient(create_app(settings, client=FakeClient(), tools=tools), base_url="http://localhost:8000")


def test_generate_saves_with_provenance_and_waits_out_the_rate_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(imagegen_module.time, "sleep", lambda s: None)
    api = lab(tmp_path, FakeTools(busy=1))
    r = api.post("/api/imagegen/generate", json={"prompt": "a sensor", "n": 2}, headers=LAB).json()
    assert len(r["items"]) == 2 and r["items"][0]["c2pa"] and r["waited_s"] > 0
    assert abs(r["cost_usd"] - (20 * 5 + 1000 * 40) / 1e6) < 1e-9
    assert api.get(f"/api/imagegen/images/{r['items'][0]['id']}").content[:4] == b"\x89PNG"
    assert len(api.get("/api/imagegen/info", headers=LAB).json()["gallery"]) == 2


def test_inpainting_resizes_the_mask_and_a_watermark_drops_the_credentials(tmp_path: Path) -> None:
    tools = FakeTools()
    api = lab(tmp_path, tools)
    first = api.post("/api/imagegen/generate", json={"prompt": "a kitchen"}, headers=LAB).json()["items"][0]["id"]
    buf = io.BytesIO()
    Image.new("RGBA", (10, 10), (0, 0, 0, 0)).save(buf, "PNG")
    mask = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    r = api.post("/api/imagegen/edit", json={"prompt": "fix it", "images": [first], "mask": mask}, headers=LAB).json()
    assert r["items"][0]["kind"] == "inpainted" and Image.open(io.BytesIO(tools.edits[-1][1])).size == (64, 48)
    wm = api.post("/api/imagegen/watermark", json={"id": first, "text": "AI-generated"}, headers=LAB).json()
    assert wm["item"]["id"].startswith(wm["item"]["id"][:12]) and not wm["item"]["c2pa"] and "drops" in wm["note"]


def test_bad_references_and_missing_configuration(tmp_path: Path) -> None:
    api = lab(tmp_path, FakeTools())
    assert api.post("/api/imagegen/edit", json={"prompt": "x", "images": ["../../etc/passwd"]}, headers=LAB).status_code == 400
    assert api.post("/api/imagegen/edit", json={"prompt": "x", "images": ["sample:ceiling"]}, headers=LAB).status_code == 404
    assert lab(tmp_path, None).post("/api/imagegen/generate", json={"prompt": "x"}, headers=LAB).status_code == 503
