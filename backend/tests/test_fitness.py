"""The fitness coach: the model gets the page's measurements as text (or a photo), and its reply is charged."""
from __future__ import annotations

import base64
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services.fitness import describe
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB

PLANK = {
    "exercise": "plank", "exercise_label": "Plank", "view": "side", "in_position": True,
    "hold_seconds": 20, "target_seconds": 30,
    "measures": [{"label": "Body line (shoulder-hip-ankle)", "value": 158, "unit": "°", "ideal": "170° to 180°"},
                 {"label": "Shoulders past elbows", "value": 0.04, "unit": " torso lengths", "ideal": "within ±0.3"}],
    "checks": [{"label": "Hips in line", "ok": False, "detail": "hips sagging by 22°"},
               {"label": "Knees straight", "ok": True}],
}


def app(tmp_path: Path, fake: ScriptedClient) -> TestClient:
    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    return TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")


def test_the_measurements_become_plain_text() -> None:
    sent = describe(PLANK)
    assert "Exercise: Plank" in sent and "side-on" in sent and "Held for 20 seconds of a 30 second target." in sent
    assert "- Body line (shoulder-hip-ankle): 158° (aim for 170° to 180°)" in sent
    assert "- Hips in line: NEEDS FIXING: hips sagging by 22°" in sent and "- Knees straight: OK" in sent
    assert "not in the position" in describe({**PLANK, "in_position": False, "view": "front"})


def test_coach_sends_numbers_only_and_charges_the_reply(tmp_path: Path) -> None:
    fake = ScriptedClient([[text("Lift your hips a little.  Ten seconds to go!")]])
    client = app(tmp_path, fake)
    r = client.post("/api/fitness/coach", headers=LAB, json={**PLANK, "model": "claude-haiku-5-5"})
    body = r.json()
    assert r.status_code == 200 and body["reply"] == "Lift your hips a little. Ten seconds to go!"
    assert body["cost_usd"] > 0 and body["photo_sent"] is False and "How's my form?" in body["sent"]
    content = fake.calls[0][1]["messages"][0]["content"]
    assert [c["type"] for c in content] == ["text"] and "hips sagging" in content[0]["text"]
    assert client.post("/api/fitness/coach", json=PLANK).status_code in (400, 403)


def test_a_photo_goes_as_an_image_block_and_must_be_a_jpeg(tmp_path: Path) -> None:
    jpeg = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe0" + b"0" * 100).decode()
    fake = ScriptedClient([[text("Your hips look low.")]])
    client = app(tmp_path, fake)
    r = client.post("/api/fitness/coach", headers=LAB,
                    json={**PLANK, "send": "photo", "photo": jpeg, "question": "Am I straight?"})
    assert r.status_code == 200 and r.json()["photo_sent"] is True
    content = fake.calls[0][1]["messages"][0]["content"]
    assert content[0]["type"] == "image" and "no measurements" in content[1]["text"]
    assert "Am I straight?" in content[1]["text"] and "Measurements" not in content[1]["text"]
    png = "data:image/png;base64," + base64.b64encode(b"\x89PNG" + b"0" * 10).decode()
    bad = client.post("/api/fitness/coach", headers=LAB, json={**PLANK, "send": "both", "photo": png})
    assert bad.status_code == 400 and "JPEG" in bad.json()["error"]["message"]


def test_unknown_exercises_are_refused(tmp_path: Path) -> None:
    client = app(tmp_path, ScriptedClient([]))
    assert client.post("/api/fitness/coach", headers=LAB, json={**PLANK, "exercise": "burpee"}).status_code in (400, 422)
