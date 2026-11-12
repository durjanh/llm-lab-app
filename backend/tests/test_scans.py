"""The scan explainer: the file and wording checks in code, then a read through the API with a scripted model that
states a diagnosis once. No network, no cost."""
from __future__ import annotations

import base64
import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services import scans
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB
from backend.tests.test_whiteboard import png

READING = {"is_medical_image": True, "modality": "MRI, T2-weighted", "body_region": "brain", "view": "axial",
           "quality": "limited", "quality_limits": "One slice only.",
           "observations": [{"what": "Widened sulci", "where": "both temporal lobes", "confidence": "low",
                             "box": [0.1, 0.3, 0.95, 0.4],
                             "plain": "The folds at the sides may look wider than expected."}],
           "looks_normal": ["The ventricles appear symmetrical."], "cannot_tell": ["Change over time."],
           "possibilities": [{"name": "Age-related volume loss", "why": "Could be consistent with wider sulci.",
                              "also_consider": "Normal variation."}],
           "urgency": "routine", "urgency_reason": "Nothing that appears to need same-day attention.",
           "questions": ["Has this changed since my last scan?"],
           "summary": "This appears to be one slice of a brain MRI. It may show slightly wider folds.",
           "answer": "One picture cannot show whether memory problems have a cause in the brain; your doctor decides."}


HAIKU = {"model": "claude-haiku-5-5"}  # Opus, the page's default, goes through the SDK's beta path, which the fake does not script


def test_only_real_pictures_are_accepted() -> None:
    assert scans.image_type(b"\x89PNG....") == "image/png"
    assert scans.image_type(b"\xff\xd8\xff\xe0") == "image/jpeg"
    assert scans.image_type(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert scans.image_type(b"RIFF\x00\x00\x00\x00WAVEfmt ") is None
    assert scans.image_type(b"\x00" * 128 + b"DICM") is None  # DICOM must be exported as a picture first


def test_wording_that_states_a_conclusion_is_caught() -> None:
    assert scans.problems(READING) == []
    for bad in ("You have Alzheimer's disease.", "This is a tumour in the left lobe.", "This confirms the bleed.",
                "You should start donepezil 5 mg."):
        assert scans.problems({**READING, "summary": bad}), bad
    for fine in ("If you have symptoms, tell your doctor.", "A radiologist would need to confirm this.",
                 "This could be consistent with a small stroke."):
        assert scans.problems({**READING, "summary": fine}) == [], fine
    assert scans.problems({**READING, "answer": "Yes, you have early dementia."})
    assert scans.problems({**READING, "questions": []}) and scans.problems({**READING, "cannot_tell": []})
    assert scans.problems({"is_medical_image": False}) == []


def test_a_read_through_the_api_gets_one_retry_and_code_writes_the_urgent_message(tmp_path: Path) -> None:
    bad = {**READING, "summary": "You have dementia."}
    urgent = {**READING, "urgency": "urgent"}
    fake = ScriptedClient([[text(json.dumps(bad))], [text(json.dumps(urgent))], [text(json.dumps(bad))],
                           [text(json.dumps(bad))], [text(json.dumps({"is_medical_image": False}))],
                           [text(json.dumps({"answer": "It may be normal for your age.", "marks": [{"label": "here", "box": [0.2, 0.2, 0.3, 0.3]}, {"label": "bad", "box": [2, 2, 1, 1]}]}))],
                           [text(json.dumps({"answer": "You should take 10 mg.", "marks": []}))]])
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    r = client.post("/api/scans/read", headers=LAB, json={**HAIKU, "image": png(), "note": "Do I have dementia?"}).json()
    assert [t["attempt"] for t in r["tries"]] == [1, 2] and "you have dementia" in r["tries"][0]["problems"][0].lower()
    assert r["reading"]["observations"][0]["box"] == [0.1, 0.3, 0.9, 0.4]  # clipped to the picture
    assert r["urgent_message"] == scans.URGENT and r["notice"] == scans.NOTICE and r["model"] == "claude-haiku-5-5"
    assert client.get("/api/scans/info", headers=LAB).json()["model"] == scans.READ_MODEL == "claude-opus-5-5"
    sent = fake.calls[0][1]
    assert sent["messages"][0]["content"][0]["source"]["media_type"] == "image/png"
    assert "cannot be shown to a patient" in fake.calls[1][1]["messages"][0]["content"][-1]["text"]
    # twice wrong: nothing is shown
    assert client.post("/api/scans/read", headers=LAB, json={**HAIKU, "image": png()}).status_code == 502
    holiday = client.post("/api/scans/read", headers=LAB, json={**HAIKU, "image": png()}).json()
    assert holiday["message"] == scans.NOT_MEDICAL and holiday["urgent_message"] is None
    ask = {**HAIKU, "question": "Is that normal?", "reading": READING}
    first = client.post("/api/scans/ask", headers=LAB, json=ask).json()
    assert first["answer"] == "It may be normal for your age."
    assert first["marks"] == [{"label": "here", "box": [0.2, 0.2, 0.3, 0.3]}]  # the impossible box is dropped
    assert "not shown" in client.post("/api/scans/ask", headers=LAB, json=ask).json()["answer"]
    not_a_picture = base64.b64encode(b"\x00" * 128 + b"DICM" + b"\x00" * 200).decode()
    assert client.post("/api/scans/read", headers=LAB, json={"image": not_a_picture}).status_code == 400
    assert not any(tmp_path.rglob("*.png"))  # nothing uploaded is stored
