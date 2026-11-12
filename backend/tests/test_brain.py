"""The brain health check: the scoring and the outcome rules in code, then a whole check through the API with a
scripted model. No network, no cost."""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services import brain
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB
from backend.tests.test_whiteboard import png

GOOD_CLOCK = {"is_clock": True, "has_circle": True, "numbers_present": list(range(1, 13)), "numbers_placed_well": True,
              "hands": 2, "hour_hand_at": 11, "minute_hand_at": 2, "notes": ""}


def test_recall_ignores_order_plurals_and_extra_words() -> None:
    r = brain.score_recall(["apple", "river", "chair", "garden", "candle"], ["Candles, apple", "um river"])
    assert r["score"] == 3 and r["missed"] == ["chair", "garden"]


def test_orientation_allows_a_day_either_side_but_not_the_wrong_year() -> None:
    today = date(2026, 11, 12)  # a Thursday
    right = brain.score_orientation({"weekday": "Thursday", "day": 13, "month": "November", "year": "2026"}, today)
    assert right["score"] == 4
    wrong = brain.score_orientation({"weekday": "friday", "day": "20", "month": "11", "year": 2025}, today)
    assert wrong["right"] == {"weekday": False, "day": False, "month": True, "year": False}


def test_the_clock_is_scored_by_code_from_what_the_model_saw() -> None:
    assert brain.score_clock(GOOD_CLOCK)["score"] == 5
    crowded = {**GOOD_CLOCK, "numbers_present": [12, 1, 2, 3, 4, 5, 6], "numbers_placed_well": False, "minute_hand_at": 10}
    assert brain.score_clock(crowded)["score"] == 2
    assert brain.score_clock({**GOOD_CLOCK, "is_clock": False})["score"] == 0
    assert brain.clock_problems({**GOOD_CLOCK, "numbers_present": [13]})


def test_animals_the_person_did_not_say_are_not_counted() -> None:
    kept = brain.count_animals(["dog", "dogs", "polar bear", "unicorn", "cat"], "dog, dogs, a polar bear and then cats")
    assert kept == ["dog", "polar bear", "cat"]


def test_the_outcome_follows_fixed_rules() -> None:
    def scores(recall: int, clock: int, animals: int) -> dict:
        return {"recall": {"score": recall}, "orientation": {"score": 4}, "clock": {"score": clock},
                "fluency": {"count": animals}, "total": recall + 4 + clock}
    assert brain.decide(scores(5, 5, 18), False, [])["key"] == "fine"
    assert brain.decide(scores(5, 3, 18), False, [])["key"] == "repeat"
    assert brain.decide(scores(2, 3, 18), False, [])["key"] == "gp"
    assert brain.decide(scores(5, 5, 18), True, [])["key"] == "concern"
    fell = brain.decide(scores(3, 4, 15), False, [{"total": 14, "recall": 5}])
    assert fell["key"] == "gp" and len(fell["drops"]) == 2


def test_a_whole_check_through_the_api(tmp_path: Path) -> None:
    fake = ScriptedClient([[text(json.dumps(GOOD_CLOCK))], [text(json.dumps({"animals": ["cat", "dog", "dragonfly"]}))]])
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    info = client.get("/api/brain/info", headers=LAB).json()
    assert len(info["risks"]) == 14 and "advice" not in info["risks"][0]
    started = client.post("/api/brain/checks", headers=LAB).json()
    cid, words = started["check_id"], started["words"]
    clock = client.post(f"/api/brain/checks/{cid}/clock", headers=LAB, json={"image": png()}).json()
    assert clock["clock"]["score"] == 5 and fake.calls[0][1]["messages"][0]["content"][0]["type"] == "image"
    today = date.today()
    body = {"user": "Sam", "save": True, "today": today.isoformat(), "recall": words[:4],
            "orientation": {"weekday": brain.WEEKDAYS[today.weekday()], "day": today.day, "month": today.month,
                            "year": today.year},
            "fluency_text": "cat dog", "risks": {"smoking": "yes", "blood_pressure": "unsure", "vision": "unsure"}}
    done = client.post(f"/api/brain/checks/{cid}/finish", headers=LAB, json=body).json()
    assert done["scores"]["total"] == 13 and done["scores"]["fluency"]["animals"] == ["cat", "dog"]  # no dragonfly
    assert done["outcome"]["key"] == "repeat" and done["outcome"]["low"] == ["naming animals"]
    assert [r["factor"] for r in done["risks"]] == ["High blood pressure", "Smoking"]
    assert client.get(f"/api/brain/checks/{cid}/pdf", headers=LAB).content.startswith(b"%PDF")
    assert client.get("/api/brain/history/sam", headers=LAB).json()["history"][0]["total"] == 13
    assert client.delete("/api/brain/history/sam", headers=LAB).json() == {"history": []}
    assert not (tmp_path / "brain-check" / "sam.json").exists()
    assert client.post("/api/brain/checks/nope/finish", headers=LAB, json=body).status_code == 404
