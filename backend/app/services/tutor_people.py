"""The tutor's people: you, your colleagues, anyone, each with a name, a face and a voice.

A face is one of the built-in avatars, or a GLB you upload (a 3D person with a humanoid rig and the ARKit and Oculus
mouth shapes TalkingHead animates, as Avaturn and similar tools export). A voice is one of Azure's neural voices, or
the person's own voice through Azure personal voice, made from two recordings: the person reading Microsoft's consent
statement, and a short sample. Azure checks the consent recording matches the sample's speaker, so nobody's voice can
be copied without them saying, in that voice, that they agree.

People are kept in generated/tutor-people/people.json, their avatars and samples beside it. The cloning steps run at
Azure: start() sends the consent, refresh() moves on to the voice once Azure has accepted the consent, and records the
speaker profile id once the voice is ready.
"""
from __future__ import annotations

import json
import secrets
import struct
import threading
from pathlib import Path
from typing import Any

from ..core.errors import ApiError
from ..gateways.personal_voice import PersonalVoices, PersonalVoiceUnavailable

BUILT_IN_AVATARS = {"sonia": "F", "ava": "F", "ryan": "M"}
MAX_PEOPLE = 30
MAX_AVATAR_BYTES = 60 * 2**20
MAX_WAV_BYTES = 30 * 2**20
BASE_MODEL = "PhoenixLatestNeural"  # the personal voice model that also sends word timings and mouth shapes
LOCALES = ["en-GB", "en-US"]

# A choice of Azure's neural voices; any of them works with the avatars' lip-sync.
STANDARD_VOICES = {
    "en-GB-SoniaNeural": "Sonia (British, female)", "en-GB-RyanNeural": "Ryan (British, male)",
    "en-GB-LibbyNeural": "Libby (British, female)", "en-GB-ThomasNeural": "Thomas (British, male)",
    "en-GB-MaisieNeural": "Maisie (British, girl)", "en-GB-OliverNeural": "Oliver (British, male)",
    "en-US-AvaNeural": "Ava (American, female)", "en-US-AndrewNeural": "Andrew (American, male)",
    "en-US-EmmaNeural": "Emma (American, female)", "en-US-BrianNeural": "Brian (American, male)",
    "en-AU-NatashaNeural": "Natasha (Australian, female)", "en-AU-WilliamNeural": "William (Australian, male)",
    "en-IN-NeerjaNeural": "Neerja (Indian English, female)", "en-IN-PrabhatNeural": "Prabhat (Indian English, male)",
    "en-IE-EmilyNeural": "Emily (Irish, female)", "en-IE-ConnorNeural": "Connor (Irish, male)",
    "en-ZA-LeahNeural": "Leah (South African, female)", "en-NG-AbeoNeural": "Abeo (Nigerian English, male)",
}

CONSENT = ("I {name} am aware that recordings of my voice will be used by {company} to create and use a synthetic "
           "version of my voice.")
SAMPLE_TEXT = ("Good morning. I'm recording this so the tutor can speak in my own voice. I'll read a few ordinary "
               "sentences at my normal speed. The weather has been changeable this week, so I've carried an umbrella "
               "everywhere. On Saturdays I like to walk by the river, then have a coffee and read for an hour. Numbers "
               "are tricky to say clearly: three hundred and forty-two, nineteen eighty-seven, and seven point five. "
               "Thank you for listening; that should be plenty to work with.")


def wav_seconds(raw: bytes) -> float:
    """The length of a PCM WAV file, from its header. Raises ValueError for anything else."""
    if len(raw) < 44 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("not a WAV file")
    pos, rate, channels, bits, data = 12, 0, 0, 0, 0
    while pos + 8 <= len(raw):
        chunk, size = raw[pos:pos + 4], struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        if chunk == b"fmt ":
            _, channels, rate, _, _, bits = struct.unpack("<HHIIHH", raw[pos + 8:pos + 24])
        elif chunk == b"data":
            data = min(size, len(raw) - pos - 8)
            break
        pos += 8 + size + (size & 1)
    if not (rate and channels and bits and data):
        raise ValueError("WAV header without format or data")
    return data / (rate * channels * bits / 8)


class TutorPeopleService:
    def __init__(self, folder: Path, voices: PersonalVoices):
        self.folder, self.voices = folder, voices
        self.avatars = folder / "avatars"
        self.samples = folder / "samples"
        self._lock = threading.Lock()

    # ----- the store -----

    def _load(self) -> list[dict[str, Any]]:
        try:
            return json.loads((self.folder / "people.json").read_text())
        except (OSError, ValueError):
            return []

    def _save(self, people: list[dict[str, Any]]) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        path = self.folder / "people.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(people, indent=2))
        tmp.replace(path)

    def _find(self, people: list[dict[str, Any]], person_id: str) -> dict[str, Any]:
        for p in people:
            if p["id"] == person_id:
                return p
        raise ApiError(404, "not_found", "No such person.")

    def _public(self, p: dict[str, Any]) -> dict[str, Any]:
        out = {k: p[k] for k in ("id", "name", "body", "avatar", "voice", "locale")}
        glb = self.avatars / f"{p['id']}.glb"
        # The file's time in the URL, so a new upload is not served from the browser's cache.
        out["avatar_url"] = (f"/api/tutor/people/{p['id']}/avatar.glb?v={int(glb.stat().st_mtime)}"
                             if p["avatar"] == "custom" and glb.exists() else None)
        pv = p.get("personal")
        out["personal"] = ({"status": pv["status"], "error": pv.get("error"), "speaker_profile_id": pv.get("speaker_profile_id"),
                            "base_model": BASE_MODEL} if pv else None)
        return out

    def list(self) -> dict[str, Any]:
        return {"people": [self._public(p) for p in self._load()], "standard_voices": STANDARD_VOICES,
                "built_in_avatars": BUILT_IN_AVATARS, "locales": LOCALES, "consent": CONSENT, "sample_text": SAMPLE_TEXT,
                "personal_voice": self.voices.status(), "base_model": BASE_MODEL}

    def _check(self, name: str, body: str, avatar: str, voice: str, locale: str) -> None:
        if not name.strip():
            raise ApiError(400, "invalid_request", "Give the person a name.")
        if body not in ("F", "M"):
            raise ApiError(400, "invalid_request", "Body must be F or M (it sets the avatar's idle poses).")
        if avatar not in {*BUILT_IN_AVATARS, "custom"}:
            raise ApiError(400, "invalid_request", "Choose a built-in face or upload one.")
        if voice not in STANDARD_VOICES:
            raise ApiError(400, "invalid_request", "Choose one of the listed voices.")
        if locale not in LOCALES:
            raise ApiError(400, "invalid_request", f"Locale must be one of: {', '.join(LOCALES)}.")

    def create(self, name: str, body: str, avatar: str, voice: str, locale: str) -> dict[str, Any]:
        self._check(name, body, avatar, voice, locale)
        with self._lock:
            people = self._load()
            if len(people) >= MAX_PEOPLE:
                raise ApiError(409, "too_many", f"There are already {MAX_PEOPLE} people; delete one first.")
            person = {"id": secrets.token_hex(5), "name": name.strip()[:40], "body": body,
                      "avatar": "sonia" if avatar == "custom" else avatar,  # custom once a file is uploaded
                      "voice": voice, "locale": locale, "personal": None}
            people.append(person)
            self._save(people)
        return self._public(person)

    def update(self, person_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            people = self._load()
            p = self._find(people, person_id)
            merged = {**p, **{k: v for k, v in changes.items() if v is not None}}
            if merged["avatar"] == "custom" and not (self.avatars / f"{person_id}.glb").exists():
                raise ApiError(400, "invalid_request", "Upload a GLB first.")
            self._check(merged["name"], merged["body"], merged["avatar"], merged["voice"], merged["locale"])
            p.update({k: merged[k] for k in ("name", "body", "avatar", "voice", "locale")})
            p["name"] = p["name"].strip()[:40]
            self._save(people)
        return self._public(p)

    def delete(self, person_id: str) -> dict[str, Any]:
        """Deletes the person here, their files, and their personal voice and consent at Azure."""
        with self._lock:
            people = self._load()
            p = self._find(people, person_id)
            pv = p.get("personal") or {}
            if pv.get("consent_id") or pv.get("voice_id"):
                try:
                    self.voices.delete(pv.get("voice_id"), pv.get("consent_id"))
                except PersonalVoiceUnavailable as exc:
                    raise ApiError(502, "azure_refused", f"Azure would not delete the voice, so nothing was deleted: {exc}") from exc
            for f in (self.avatars / f"{person_id}.glb", self.samples / f"{person_id}.wav"):
                f.unlink(missing_ok=True)
            self._save([q for q in people if q["id"] != person_id])
        return {"deleted": person_id}

    # ----- the face -----

    def upload_avatar(self, person_id: str, raw: bytes) -> dict[str, Any]:
        if len(raw) > MAX_AVATAR_BYTES:
            raise ApiError(400, "invalid_request", f"The model is over {MAX_AVATAR_BYTES // 2**20} MB.")
        if raw[:4] != b"glTF":
            raise ApiError(400, "invalid_request", "Upload a binary glTF (.glb) file.")
        with self._lock:
            people = self._load()
            p = self._find(people, person_id)
            self.avatars.mkdir(parents=True, exist_ok=True)
            (self.avatars / f"{person_id}.glb").write_bytes(raw)
            p["avatar"] = "custom"
            self._save(people)
        return self._public(p)

    def avatar_file(self, person_id: str) -> Path:
        path = self.avatars / f"{person_id}.glb"
        if not path.exists():
            raise ApiError(404, "not_found", "No uploaded avatar for this person.")
        return path

    # ----- the voice -----

    def consent_text(self, name: str, company: str) -> str:
        return CONSENT.format(name=name.strip(), company=company.strip())

    def start_voice(self, person_id: str, company: str, consent_wav: bytes, sample_wav: bytes) -> dict[str, Any]:
        """Sends the consent recording to Azure and keeps the sample until Azure has accepted it."""
        if not company.strip():
            raise ApiError(400, "invalid_request", "Name the company or organisation: the consent statement says it.")
        for label, raw, low, high in (("consent", consent_wav, 3, 40), ("sample", sample_wav, 5, 90)):
            if len(raw) > MAX_WAV_BYTES:
                raise ApiError(400, "invalid_request", f"The {label} recording is over 30 MB.")
            try:
                seconds = wav_seconds(raw)
            except ValueError:
                raise ApiError(400, "invalid_request", f"The {label} recording must be a WAV file.") from None
            if not low <= seconds <= high:
                raise ApiError(400, "invalid_request", f"The {label} recording is {seconds:.0f} s; it must be {low} to {high} s.")
        status = self.voices.status()
        if not status.get("ready"):
            raise ApiError(409, "personal_voice_unavailable", status.get("detail") or "Personal voice is not available.")
        with self._lock:
            people = self._load()
            p = self._find(people, person_id)
            if p.get("personal") and p["personal"]["status"] in ("consent", "voice"):
                raise ApiError(409, "busy", "Azure is still working on this person's voice.")
            stamp = secrets.token_hex(3)
            consent_id, voice_id = f"tutor-{person_id}-consent-{stamp}", f"tutor-{person_id}-voice-{stamp}"
            try:
                self.voices.create_consent(consent_id, p["name"], company.strip(), p["locale"], consent_wav)
            except PersonalVoiceUnavailable as exc:
                raise ApiError(502, "azure_refused", str(exc)) from exc
            self.samples.mkdir(parents=True, exist_ok=True)
            (self.samples / f"{person_id}.wav").write_bytes(sample_wav)
            p["personal"] = {"status": "consent", "consent_id": consent_id, "voice_id": voice_id, "company": company.strip()}
            self._save(people)
        return self._public(p)

    def refresh_voice(self, person_id: str) -> dict[str, Any]:
        """Moves the cloning on: consent accepted → send the sample; voice ready → keep its speaker profile id."""
        with self._lock:
            people = self._load()
            p = self._find(people, person_id)
            pv = p.get("personal")
            if not pv or pv["status"] not in ("consent", "voice"):
                return self._public(p)
            try:
                if pv["status"] == "consent":
                    state = self.voices.consent(pv["consent_id"])
                    if state.get("status") == "Succeeded":
                        sample = self.samples / f"{person_id}.wav"
                        made = self.voices.create_voice(pv["voice_id"], pv["consent_id"], sample.read_bytes())
                        pv.update(status="voice", speaker_profile_id=made.get("speakerProfileId"))
                    elif state.get("status") == "Failed":
                        pv.update(status="failed", error=f"Azure rejected the consent recording. {state.get('statusMessage', '')}".strip())
                else:
                    state = self.voices.voice(pv["voice_id"])
                    if state.get("status") == "Succeeded":
                        pv.update(status="ready", speaker_profile_id=state.get("speakerProfileId") or pv.get("speaker_profile_id"))
                        (self.samples / f"{person_id}.wav").unlink(missing_ok=True)
                    elif state.get("status") == "Failed":
                        pv.update(status="failed", error=f"Azure could not make the voice. {state.get('statusMessage', '')}".strip())
            except (PersonalVoiceUnavailable, OSError) as exc:
                pv.update(status="failed", error=str(exc))
            self._save(people)
        return self._public(p)

    def remove_voice(self, person_id: str) -> dict[str, Any]:
        """Deletes the person's cloned voice and consent at Azure; they go back to their chosen standard voice."""
        with self._lock:
            people = self._load()
            p = self._find(people, person_id)
            pv = p.get("personal") or {}
            try:
                self.voices.delete(pv.get("voice_id"), pv.get("consent_id"))
            except PersonalVoiceUnavailable as exc:
                raise ApiError(502, "azure_refused", str(exc)) from exc
            (self.samples / f"{person_id}.wav").unlink(missing_ok=True)
            p["personal"] = None
            self._save(people)
        return self._public(p)

    def token(self) -> dict[str, Any]:
        try:
            return {"token": self.voices.token(), "region": self.voices.region}
        except PersonalVoiceUnavailable as exc:
            raise ApiError(503, "personal_voice_unavailable", str(exc)) from exc
