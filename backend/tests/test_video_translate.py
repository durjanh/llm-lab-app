"""Video translation: the timing rules, the caps, the per-language caching and a whole run through the API, with a
fake Azure Speech and a fake Translator. ffmpeg makes a real two-second test video; no network, no cost."""
from __future__ import annotations

import io
import json
import struct
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services import video_translate as vt
from backend.app.settings import Settings
from backend.tests.test_api import LAB

FFMPEG = vt.find_tool("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(not (FFMPEG and vt.find_tool("ffprobe")), reason="ffmpeg is not installed")


def wav(seconds: float) -> bytes:
    """A silent 16 kHz mono WAV of the given length."""
    frames = int(seconds * 16000)
    data = b"\x00\x00" * frames
    return (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16)
            + b"data" + struct.pack("<I", len(data)) + data)


class FakeSpeech:
    """Spanish phrases with times; speech lasts 0.1 s per character at normal speed."""

    def __init__(self) -> None:
        self.transcribed, self.spoken = 0, []

    def transcribe(self, audio: bytes, locales: list[str]) -> dict:
        self.transcribed += 1
        assert audio.startswith(b"RIFF") and "es-ES" in locales and "en-GB" in locales
        return {"durationMilliseconds": 2000, "phrases": [
            {"locale": "es-ES", "offsetMilliseconds": 0, "durationMilliseconds": 900, "text": "Hola a todos."},
            {"locale": "es-ES", "offsetMilliseconds": 1000, "durationMilliseconds": 800, "text": "Gracias."},
            {"locale": "es-ES", "offsetMilliseconds": 1900, "durationMilliseconds": 50, "text": "  "}]}

    def synthesize(self, ssml: str) -> bytes:
        rate = 1 + int(ssml.split("rate='")[1].split("%")[0]) / 100
        text = ssml.split(">")[-4].split("<")[0]
        self.spoken.append((text, rate))
        return wav(len(text) * 0.1 / rate)


class FakeTranslator:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None]] = []

    def translate(self, text: str, to: str, source: str | None = None) -> str:
        self.calls.append((text, to, source))
        return {"Hola a todos.": "Hello everyone.", "Gracias.": "Thanks."}.get(text, text) if to == "en" else f"[{to}] {text}"


def test_a_phrase_too_long_for_its_slot_is_spoken_faster_but_not_too_fast() -> None:
    assert vt.fit_rate(1.0, 2.0) == 1.0
    assert vt.fit_rate(2.4, 2.0) == 1.2
    assert vt.fit_rate(9.0, 2.0) == vt.MAX_RATE
    segs = [{"start": 0.0, "end": 0.9}, {"start": 1.0, "end": 1.8}]
    assert vt.slots(segs, 5.0) == [pytest.approx(0.9), pytest.approx(3.9)]  # the last one may run to the end


def test_phrases_and_the_main_language_come_from_the_transcript() -> None:
    segs, locale = vt.segments_from({"phrases": [
        {"locale": "ar-SA", "offsetMilliseconds": 500, "durationMilliseconds": 3000, "text": "مرحبا"},
        {"locale": "en-GB", "offsetMilliseconds": 4000, "durationMilliseconds": 500, "text": "OK"}]})
    assert locale == "ar-SA" and vt.code_of(locale) == "ar"
    assert segs[0] == {"start": 0.5, "end": 3.5, "source_text": "مرحبا", "locale": "ar-SA"}
    assert "<prosody rate='+20%'>a &lt; b</prosody>" in vt.ssml("a < b", "en", 1.2)


@pytest.fixture()
def video(tmp_path: Path) -> bytes:
    path = tmp_path / "clip.mp4"
    subprocess.run([FFMPEG, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:d=2:r=10", "-f", "lavfi",
                    "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                    "-shortest", str(path)], check=True)
    return path.read_bytes()


def app_with(tmp_path: Path, speech: FakeSpeech, translator: FakeTranslator) -> TestClient:
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    app = create_app(settings, client=object())
    c = app.state.container
    object.__setattr__(c, "video_translate", vt.VideoTranslateService(speech, translator, c.spend, _streamer(c),
                                                                      tmp_path / "video-translate"))
    return TestClient(app, base_url="http://localhost:8000")


def _streamer(c):  # the container keeps the runs registry; a streamer over it, as the container builds one
    from backend.app.services.runs import RunStreamer
    return RunStreamer(c.runs, 15.0)


def events(response) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


@needs_ffmpeg
def test_a_whole_run_transcribes_once_and_caches_each_language(tmp_path: Path, video: bytes) -> None:
    speech, translator = FakeSpeech(), FakeTranslator()
    client = app_with(tmp_path, speech, translator)
    up = client.post("/api/video-translate/uploads", headers=LAB, files={"file": ("clip.mp4", video, "video/mp4")}).json()
    assert up["duration_s"] == pytest.approx(2.0, abs=0.2) and len(up["id"]) == 32

    run = events(client.post(f"/api/video-translate/uploads/{up['id']}/translate", headers=LAB,
                             json={"language": "en", "voice": True}))
    steps = [e.get("step") for e in run if e["type"] == "step"]
    assert steps[:2] == ["extracting", "transcribing"] and "translating" in steps and "voicing" in steps
    done = run[-1]
    assert done["type"] == "done" and done["detected"]["code"] == "es" and done["detected"]["name"] == "Spanish"
    assert [s["text"] for s in done["segments"]] == ["Hello everyone.", "Thanks."]  # the blank phrase is dropped
    first, last = done["segments"]
    # "Hello everyone." is 1.5 s at normal speed but has 0.9 s before the next phrase: spoken at the most allowed
    assert first["rate"] == vt.MAX_RATE and last["rate"] == 1.0
    assert done["cost_usd"] > 0

    # The audio and the video are served to <audio> and <video> tags, which cannot send the lab header.
    assert client.get(first["audio"]).content.startswith(b"RIFF")
    assert client.get(f"/api/video-translate/media/{up['id']}/source").headers["content-type"] == "video/mp4"

    # Again in English: nothing is sent to Azure. In French: translated, but not transcribed again.
    calls = len(translator.calls)
    again = events(client.post(f"/api/video-translate/uploads/{up['id']}/translate", headers=LAB,
                               json={"language": "en", "voice": True}))[-1]
    assert again["segments"] == done["segments"] and len(translator.calls) == calls and again["cost_usd"] == 0
    fr = events(client.post(f"/api/video-translate/uploads/{up['id']}/translate", headers=LAB,
                            json={"language": "fr", "voice": False}))[-1]
    assert speech.transcribed == 1 and fr["segments"][0]["text"] == "[fr] Hola a todos."
    assert "audio" not in fr["segments"][0]
    assert all(source == "es" for _, _, source in translator.calls)

    # Into the language it was spoken in: the words stay, nothing is translated.
    es = events(client.post(f"/api/video-translate/uploads/{up['id']}/translate", headers=LAB,
                            json={"language": "es", "voice": False}))[-1]
    assert es["segments"][0]["text"] == "Hola a todos." and len(translator.calls) == calls + 2


@needs_ffmpeg
def test_uploads_are_capped_and_checked(tmp_path: Path, video: bytes, monkeypatch: pytest.MonkeyPatch) -> None:
    client = app_with(tmp_path, FakeSpeech(), FakeTranslator())
    post = lambda name, data: client.post("/api/video-translate/uploads", headers=LAB, files={"file": (name, data)})
    assert post("notes.txt", b"hello").status_code == 400
    assert post("fake.mp4", b"not a video at all").status_code == 400
    monkeypatch.setattr(vt, "MAX_SECONDS", 1)
    r = post("clip.mp4", video)
    assert r.status_code == 400 and "minutes" in r.json()["error"]["message"]
    monkeypatch.setattr(vt, "MAX_BYTES", 1000)
    assert post("clip.mp4", video).status_code == 413
    assert not [p for p in (tmp_path / "video-translate").iterdir() if p.is_dir()]  # refused uploads leave nothing
    assert client.get("/api/video-translate/media/" + "0" * 32 + "/source").status_code == 404
    assert client.get("/api/video-translate/media/../../etc/source").status_code == 404
    bad = client.post("/api/video-translate/uploads/" + "0" * 32 + "/translate", headers=LAB, json={"language": "en"})
    assert bad.status_code == 404
