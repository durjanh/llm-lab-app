"""The tutor's people: create, upload a face, and clone a voice through a fake Azure personal voice, so no Azure and
no cost."""
from __future__ import annotations

import struct
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.api import deps
from backend.app.gateways.personal_voice import PersonalVoiceUnavailable, explain
from backend.app.main import create_app
from backend.app.services.tutor_people import TutorPeopleService, wav_seconds
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient
from backend.tests.test_api import LAB


def wav(seconds: float, rate: int = 24000) -> bytes:
    data = b"\x00\x00" * int(seconds * rate)
    fmt = struct.pack("<HHIIHH", 1, 1, rate, rate * 2, 2, 16)
    return (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE" + b"fmt " + struct.pack("<I", 16) + fmt
            + b"data" + struct.pack("<I", len(data)) + data)


class FakeVoices:
    configured, region = True, "swedencentral"

    def __init__(self, ready: bool = True) -> None:
        self.ready = ready
        self.calls: list[tuple[str, Any]] = []
        self.consent_state = "Running"
        self.voice_state = "Running"

    def status(self) -> dict[str, Any]:
        return {"configured": True, "ready": self.ready, "detail": "Ready." if self.ready else "Azure refused: limited access."}

    def token(self) -> str:
        return "aad#res#tok"

    def create_consent(self, consent_id: str, talent: str, company: str, locale: str, wav: bytes) -> dict[str, Any]:
        self.calls.append(("consent", (consent_id, talent, company, locale, len(wav))))
        return {"status": "NotStarted"}

    def create_voice(self, voice_id: str, consent_id: str, wav: bytes) -> dict[str, Any]:
        self.calls.append(("voice", (voice_id, consent_id, len(wav))))
        return {"status": "NotStarted", "speakerProfileId": "profile-123"}

    def consent(self, consent_id: str) -> dict[str, Any]:
        return {"status": self.consent_state}

    def voice(self, voice_id: str) -> dict[str, Any]:
        return {"status": self.voice_state, "speakerProfileId": "profile-123"}

    def delete(self, voice_id: str | None, consent_id: str | None) -> None:
        self.calls.append(("delete", (voice_id, consent_id)))


def make(tmp_path: Path, voices: FakeVoices) -> tuple[TestClient, TutorPeopleService]:
    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    app = create_app(settings, client=ScriptedClient([]))
    service = TutorPeopleService(tmp_path / "tutor-people", voices)
    app.dependency_overrides[deps.tutor_people] = lambda: service
    return TestClient(app, base_url="http://localhost:8000"), service


def test_wav_length_is_read_from_the_header() -> None:
    assert wav_seconds(wav(2.5)) == pytest.approx(2.5)
    with pytest.raises(ValueError):
        wav_seconds(b"ID3 not a wav file at all, just some bytes padding it out to length..")


def test_people_are_created_changed_given_a_face_and_deleted(tmp_path: Path) -> None:
    client, service = make(tmp_path, FakeVoices())
    listing = client.get("/api/tutor/people", headers=LAB).json()
    assert listing["people"] == [] and "en-GB-SoniaNeural" in listing["standard_voices"] and listing["personal_voice"]["ready"]
    me = client.post("/api/tutor/people", headers=LAB, json={"name": "Durjan", "body": "M", "avatar": "ryan",
                                                             "voice": "en-GB-ThomasNeural"}).json()
    assert me["avatar"] == "ryan" and me["voice"] == "en-GB-ThomasNeural" and me["personal"] is None
    # a face: only a GLB is accepted, and it is served without the lab header, for the 3D loader
    bad = client.post(f"/api/tutor/people/{me['id']}/avatar", headers=LAB, files={"file": ("x.glb", b"not a model", "model/gltf-binary")})
    assert bad.status_code == 400
    up = client.post(f"/api/tutor/people/{me['id']}/avatar", headers=LAB, files={"file": ("me.glb", b"glTF" + b"\0" * 100, "model/gltf-binary")})
    assert up.json()["avatar"] == "custom" and f"{me['id']}/avatar.glb?v=" in up.json()["avatar_url"]
    assert client.get(f"/api/tutor/people/{me['id']}/avatar.glb").content.startswith(b"glTF")
    assert client.get("/api/tutor/people/..%2F..%2Fsecret/avatar.glb").status_code == 404
    changed = client.patch(f"/api/tutor/people/{me['id']}", headers=LAB, json={"voice": "en-US-BrianNeural"}).json()
    assert changed["voice"] == "en-US-BrianNeural" and changed["avatar"] == "custom"
    assert client.patch(f"/api/tutor/people/{me['id']}", headers=LAB, json={"voice": "made-up"}).status_code == 400
    assert client.post("/api/tutor/people", json={"name": "x"}).status_code in (400, 403)  # the lab-page guard
    assert client.delete(f"/api/tutor/people/{me['id']}", headers=LAB).json() == {"deleted": me["id"]}
    assert not (tmp_path / "tutor-people" / "avatars" / f"{me['id']}.glb").exists()


def test_a_voice_is_cloned_in_steps_from_consent_to_ready(tmp_path: Path) -> None:
    voices = FakeVoices()
    client, _ = make(tmp_path, voices)
    me = client.post("/api/tutor/people", headers=LAB, json={"name": "Durjan", "body": "M"}).json()
    send = lambda consent, sample: client.post(  # noqa: E731
        f"/api/tutor/people/{me['id']}/voice", headers=LAB, data={"company": "Colibri"},
        files={"consent": ("c.wav", consent, "audio/wav"), "sample": ("s.wav", sample, "audio/wav")})
    assert send(wav(8), wav(2)).status_code == 400  # a sample under 5 seconds
    assert send(wav(8), wav(120)).status_code == 400  # over 90
    assert send(b"not audio" * 10, wav(30)).status_code == 400
    started = send(wav(8), wav(30)).json()
    assert started["personal"]["status"] == "consent"
    assert voices.calls[0][0] == "consent" and voices.calls[0][1][1:4] == ("Durjan", "Colibri", "en-GB")
    assert send(wav(8), wav(30)).status_code == 409  # busy
    assert client.get(f"/api/tutor/people/{me['id']}/voice", headers=LAB).json()["personal"]["status"] == "consent"
    voices.consent_state = "Succeeded"
    assert client.get(f"/api/tutor/people/{me['id']}/voice", headers=LAB).json()["personal"]["status"] == "voice"
    assert voices.calls[-1][0] == "voice" and voices.calls[-1][1][2] > 1_000_000  # the kept sample was sent
    voices.voice_state = "Succeeded"
    ready = client.get(f"/api/tutor/people/{me['id']}/voice", headers=LAB).json()["personal"]
    assert ready["status"] == "ready" and ready["speaker_profile_id"] == "profile-123" and ready["base_model"] == "PhoenixLatestNeural"
    assert not (tmp_path / "tutor-people" / "samples" / f"{me['id']}.wav").exists()  # the sample is not kept after
    removed = client.delete(f"/api/tutor/people/{me['id']}/voice", headers=LAB).json()
    assert removed["personal"] is None and voices.calls[-1][0] == "delete"
    assert client.get("/api/tutor/personal-voice-token", headers=LAB).json() == {"token": "aad#res#tok", "region": "swedencentral"}


def test_without_approval_cloning_is_refused_with_the_reason(tmp_path: Path) -> None:
    client, _ = make(tmp_path, FakeVoices(ready=False))
    me = client.post("/api/tutor/people", headers=LAB, json={"name": "Sam"}).json()
    r = client.post(f"/api/tutor/people/{me['id']}/voice", headers=LAB, data={"company": "Colibri"},
                    files={"consent": ("c.wav", wav(8), "audio/wav"), "sample": ("s.wav", wav(30), "audio/wav")})
    assert r.status_code == 409 and "limited access" in r.json()["error"]["message"]


def test_a_failed_consent_is_reported_and_azure_refusals_are_explained(tmp_path: Path) -> None:
    voices = FakeVoices()
    client, _ = make(tmp_path, voices)
    me = client.post("/api/tutor/people", headers=LAB, json={"name": "Sam"}).json()
    client.post(f"/api/tutor/people/{me['id']}/voice", headers=LAB, data={"company": "Colibri"},
                files={"consent": ("c.wav", wav(8), "audio/wav"), "sample": ("s.wav", wav(30), "audio/wav")})
    voices.consent_state = "Failed"
    failed = client.get(f"/api/tutor/people/{me['id']}/voice", headers=LAB).json()["personal"]
    assert failed["status"] == "failed" and "consent" in failed["error"]
    assert "aka.ms/customneural" in explain(403, "")
    assert "region" in explain(400, '{"innererror":{"code":"UnsupportedApiRegion"}}')
    assert issubclass(PersonalVoiceUnavailable, RuntimeError)
