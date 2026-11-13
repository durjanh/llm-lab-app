"""The songbird composer: code checks a model's score before the page plays it, and asks once for a fix."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services.songbird import problems, to_page
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB


def n(voice: str, start: float, duration: float, f0: float, f1: float, **extra) -> dict:
    return {"voice": voice, "start": start, "duration": duration, "f_start": f0, "f_end": f1, "amplitude": 0.8,
            "harmonics": 0.1, "trill_rate": 0, "trill_depth": 0, **extra}


GOOD = {"title": "Two-voice whistle", "explanation": "Left low, right high.",
        "notes": [n("L", 0, 0.3, 1800, 2000), n("R", 0, 0.3, 3600, 3900), n("R", 0.4, 0.1, 5000, 4000, trill_rate=20, trill_depth=0.05)]}


def test_a_playable_score_has_no_problems_and_is_shaped_for_the_page() -> None:
    assert problems(GOOD) == []
    notes = to_page(GOOD)
    assert notes[0] == {"voice": "L", "t": 0.0, "d": 0.3, "f0": 1800.0, "f1": 2000.0, "amp": 0.8, "harm": 0.1}
    assert notes[-1]["trill"] == 20 and notes[-1]["trillDepth"] == 0.05


def test_ranges_overlaps_and_length_are_caught() -> None:
    bad = {"notes": [n("L", 0, 0.3, 300, 2000), n("R", 0, 0.3, 3000, 12000), n("L", 0.2, 0.3, 1500, 1600),
                     n("R", 7.9, 0.5, 3000, 3000), n("L", 1, 0.001, 1000, 1000)]}
    found = " ".join(problems(bad))
    assert "f_start 300" in found and "f_end 12000" in found and "overlap" in found
    assert "ends after 8" in found and "too short" in found
    assert problems({"notes": []}) == ["There are no notes."]


def test_compose_retries_once_with_the_problems_then_returns_the_score(tmp_path: Path) -> None:
    unplayable = {**GOOD, "notes": [n("L", 0, 0.3, 9000, 9000)]}
    fake = ScriptedClient([[text(json.dumps(unplayable))], [text(json.dumps(GOOD))]])
    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    r = client.post("/api/songbird/compose", headers=LAB, json={"description": "a duet", "model": "claude-haiku-5-5"})
    body = r.json()
    assert r.status_code == 200 and len(body["notes"]) == 3 and body["tries"][0]["problems"] and body["cost_usd"] > 0
    assert "cannot play that yet" in fake.calls[1][1]["messages"][-1]["content"]
    assert client.post("/api/songbird/compose", json={"description": "a duet"}).status_code in (400, 403)


def test_a_second_bad_score_is_refused(tmp_path: Path) -> None:
    bad = json.dumps({**GOOD, "notes": [n("L", 0, 0.3, 9000, 9000)]})
    fake = ScriptedClient([[text(bad)], [text(bad)]])
    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    r = client.post("/api/songbird/compose", headers=LAB, json={"description": "a duet", "model": "claude-haiku-5-5"})
    assert r.status_code == 502 and "second try" in r.json()["error"]["message"]
