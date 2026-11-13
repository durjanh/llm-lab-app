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


# ----- guess my drawing, bring it to life, sketch to picture -----

from backend.app.services.whiteboard import clean_guesses, is_word, normalise, scene_problems  # noqa: E402

HAIKU = "claude-haiku-5-5"


def make(tmp_path: Path, script: list, tools: object = None) -> tuple[TestClient, ScriptedClient]:
    fake = ScriptedClient(script)
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    return TestClient(create_app(settings, client=fake, tools=tools), base_url="http://localhost:8000"), fake


def test_code_decides_whether_a_guess_is_the_word() -> None:
    assert normalise("A Pine-Tree!") == "pine tree" and normalise("the cats") == "cat"
    assert is_word("tree", "a pine tree") and is_word("bicycle", "Bike") and is_word("glasses", "sunglasses")
    assert is_word("boat", "sailboat") and is_word("cat", "cats")
    assert not is_word("tree", "treehouse") and not is_word("cat", "caterpillar") and not is_word("sun", "")
    cleaned = clean_guesses({"guesses": [{"label": " Dog ", "confidence": 0.2}, {"label": "Cat", "confidence": 7},
                                         {"label": "", "confidence": 1}, {"label": "fox", "confidence": "x"},
                                         {"label": "cow", "confidence": 0.5}]})
    assert cleaned == [{"label": "cat", "confidence": 1.0}, {"label": "cow", "confidence": 0.5},
                       {"label": "dog", "confidence": 0.2}]


def test_a_guess_never_tells_the_model_the_word_and_code_marks_the_win(tmp_path: Path) -> None:
    said = {"guesses": [{"label": "dog", "confidence": 0.6}, {"label": "a kitten", "confidence": 0.3}], "comment": "Four legs."}
    client, fake = make(tmp_path, [[text(json.dumps(said))], [text(json.dumps(said))], [text("not json")]])
    r = client.post("/api/whiteboard/guess", headers=LAB, json={"image": png(), "word": "cat", "model": HAIKU}).json()
    assert r["matched"] == "a kitten" and r["guesses"][0]["label"] == "dog" and r["cost_usd"] > 0
    assert "cat" not in json.dumps(fake.calls[0][1]["messages"]) and "cat" not in fake.calls[0][1]["system"].split()
    free = client.post("/api/whiteboard/guess", headers=LAB, json={"image": png(), "model": HAIKU}).json()
    assert free["matched"] is None and len(free["guesses"]) == 2
    empty = client.post("/api/whiteboard/guess", headers=LAB, json={"image": png(), "model": HAIKU}).json()
    assert empty["guesses"] == [] and empty["matched"] is None
    assert client.post("/api/whiteboard/guess", headers=LAB, json={"image": png(), "word": "zebra crossing"}).status_code == 400
    assert client.post("/api/whiteboard/guess", json={"image": png()}).status_code in (400, 403)
    info = client.get("/api/whiteboard/info", headers=LAB).json()
    assert "cat" in info["words"]["easy"] and info["picture"] is False and "AZURE_MEDIA_ENDPOINT" in info["picture_why"]


def body(kind: str, **over: object) -> dict:
    return {"kind": kind, "label": kind, "moving": kind != "line", "x": 100, "y": 100, "width": 0, "height": 0,
            "radius": 0, "angle": 0, "x2": 0, "y2": 0, **over}


def test_a_scene_is_checked_before_it_runs() -> None:
    good = {"bodies": [body("ball", radius=20), body("box", width=60, height=40, angle=10),
                       body("line", x=50, y=300, x2=500, y2=350)], "comment": "The ball rolls."}
    assert scene_problems(good, 800, 500) == []
    bad = {"bodies": [body("ball", radius=900), body("box", width=2, height=40), body("ball", x=5000, radius=20),
                      body("line", x=10, y=10, x2=12, y2=12), body("line", x=0, y=0, x2=300, y2=0, moving=True),
                      body("spring")]}
    found = " ".join(scene_problems(bad, 800, 500))
    for part in ("radius must be", "width and height", "off the board", "at least 10 units", "lines are fixed", "kind must be"):
        assert part in found
    assert scene_problems({"bodies": []}, 800, 500)[0].startswith("there are no bodies")
    assert "limit is 40" in scene_problems({"bodies": [body("ball", radius=10)] * 41}, 800, 500)[0]


def test_a_scene_through_the_api_gets_one_retry_and_only_the_fields_each_kind_uses(tmp_path: Path) -> None:
    bad = {"bodies": [body("ball", radius=0)], "comment": ""}
    good = {"bodies": [body("ball", radius=20, x=120.26), body("line", x=50, y=300, x2=500, y2=350, moving=False)],
            "comment": "It rolls down the ramp."}
    client, fake = make(tmp_path, [[text(json.dumps(bad))], [text(json.dumps(good))]])
    hints = [{"shape": "circle", "box": [100, 80, 140, 120]}]
    r = client.post("/api/whiteboard/scene", headers=LAB, json={"image": png(), "hints": hints, "width": 800,
                                                                "height": 500, "model": HAIKU}).json()
    assert r["bodies"] == [{"kind": "ball", "label": "ball", "x": 120.3, "y": 100.0, "moving": True, "radius": 20.0},
                           {"kind": "line", "label": "line", "x": 50.0, "y": 300.0, "moving": False, "x2": 500.0, "y2": 350.0}]
    assert len(r["tries"]) == 2 and "radius" in r["tries"][0]["problems"][0]
    first = fake.calls[0][1]
    assert "800 units" in first["system"] and '"circle"' in first["messages"][0]["content"][1]["text"]
    assert "cannot be run" in fake.calls[1][1]["messages"][0]["content"][-1]["text"]


def test_sketch_to_picture_sends_the_sketch_as_the_reference_and_charges(tmp_path: Path) -> None:
    from backend.tests.test_imagegen import FakeTools

    tools = FakeTools()
    client, _ = make(tmp_path, [], tools)
    assert client.get("/api/whiteboard/info", headers=LAB).json()["picture"] is True
    r = client.post("/api/whiteboard/picture", headers=LAB, json={"image": png(), "style": "pixel art", "subject": "a boat"})
    made = r.json()
    assert r.status_code == 200 and made["cost_usd"] > 0 and "pixel art" in made["prompt"] and "a boat" in made["prompt"]
    assert len(tools.edits) == 1 and tools.edits[0][0][0].startswith(b"\x89PNG") and tools.edits[0][1] is None
    assert client.get(made["url"]).status_code == 200  # served by the image page's media route
    none, _ = make(tmp_path / "b", [])
    assert none.post("/api/whiteboard/picture", headers=LAB, json={"image": png(), "style": "pixel art"}).status_code == 503
