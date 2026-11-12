"""The AI whiteboard: the checks on what the model says the sketch is, then a read through the API with a scripted
model that gets it wrong once. No network, no cost."""
from __future__ import annotations

import base64
import json
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services.whiteboard import _check_expression, problems
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB


def png() -> str:
    """A real 1×1 PNG, base64, so the size and signature checks pass."""
    raw = b"\x00\x00\x00\x00"
    def chunk(kind: bytes, data: bytes) -> bytes:
        return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")
    body = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", (1).to_bytes(4, "big") * 2 + b"\x08\x06\x00\x00\x00")
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    return base64.b64encode(body * 20).decode()  # longer than the schema's minimum; still starts with the signature


SINE = {"kind": "function", "read_as": "y = A sin x + B", "title": "A sine wave", "x_range": [-6.3, 6.3],
        "functions": [{"expression": "A*sin(x) + B", "label": "y = A sin x + B"}],
        "parameters": [{"name": "A", "value": 1, "min": -3, "max": 3}, {"name": "B", "value": 0, "min": -3, "max": 3}],
        "solid": {"shape": "cube", "width": 2, "depth": 2, "height": 2},
        "section": {"enabled": False, "normal": [0, 1, 0], "offset": 0}, "explanation": "A stretches the wave."}


@pytest.mark.parametrize("expr, ok", [
    ("x^2 - 3", True), ("A*sin(x) + B", True), ("sqrt(abs(x)) / 2", True), ("e^(-x^2)", True),
    ("__import__('os')", False), ("x.real", False), ("open(x)", False), ("C*x", False), ("x[0]", False),
    ("lambda: 1", False), ("2 x", False),
])
def test_only_safe_maths_is_accepted(expr: str, ok: bool) -> None:
    assert (_check_expression(expr, {"A", "B"}) is None) is ok


def test_a_reading_is_checked_before_it_is_drawn() -> None:
    assert problems(SINE) == []
    bad = {**SINE, "parameters": [{"name": "A", "value": 5, "min": -3, "max": 3}], "x_range": [3, 1]}
    found = " ".join(problems(bad))
    assert "value between them" in found and "'B'" in found and "x_range" in found
    cube = {**SINE, "kind": "solid", "solid": {"shape": "cube", "width": 2, "depth": 2, "height": 0},
            "section": {"enabled": True, "normal": [0, 0, 0], "offset": 0}}
    assert len(problems(cube)) == 2


def test_a_read_through_the_api_gets_one_retry(tmp_path: Path) -> None:
    bad = {**SINE, "functions": [{"expression": "__import__('os').system('ls')", "label": "nope"}]}
    fake = ScriptedClient([[text(json.dumps(bad))], [text(json.dumps(SINE))]])
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    r = client.post("/api/whiteboard/read", headers=LAB, json={"image": png(), "prompt": "Plot this"}).json()
    assert r["board"]["kind"] == "function" and [t["attempt"] for t in r["tries"]] == [1, 2]
    assert "not x, pi, e" in r["tries"][0]["problems"][0] or "only these functions" in r["tries"][0]["problems"][0]
    sent = fake.calls[0][1]
    assert sent["messages"][0]["content"][0]["type"] == "image"
    assert sent["output_config"]["format"]["type"] == "json_schema"
    assert "could not be drawn" in fake.calls[1][1]["messages"][0]["content"][-1]["text"]
    assert client.post("/api/whiteboard/read", headers=LAB, json={"image": "x" * 200}).status_code == 400
