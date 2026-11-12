"""Video translation: a person uploads a video, Azure finds which language is spoken and writes it down with times,
and the page shows it translated, as subtitles under the video or spoken in another language over it.

The steps, all on Azure through the lab's AI Services account, keyless:
1. ffmpeg (on this machine) takes the sound out of the video as 16 kHz mono WAV.
2. Fast transcription writes it down phrase by phrase, with start and end times, and identifies the language among
   the ones the lab has voices for.
3. Translator turns each phrase into the chosen language.
4. For speech, neural text to speech says each translated phrase in that language's voice. A phrase that runs longer
   than its slot is said again a little faster (at most MAX_RATE), so it ends before the next one starts.

The transcript is kept per upload and each language's translation and speech per language, so changing the language
translates again without transcribing again. No model writes anything here: the words are Azure's speech and
translation services, and code does the timing. Uploads and what is made from them stay in generated/video-translate/.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import uuid
import wave
from io import BytesIO
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterator
from xml.sax.saxutils import escape

from ..core.errors import ApiError
from ..gateways.azure_speech_rest import SpeechRest, SpeechRestError
from ..shared import translator as shared_translator
from .runs import Run, RunStreamer
from .spend import SpendTracker

LANGUAGES = shared_translator.LANGUAGES  # code: (name, speech locale, voice)
LOCALE_TO_CODE = {locale: code for code, (_, locale, _) in LANGUAGES.items()}

MAX_BYTES = 200 * 2**20
MAX_SECONDS = 5 * 60
KEEP_UPLOADS = 10  # the oldest upload is deleted when another arrives
MAX_RATE = 1.5  # the fastest a translated phrase is spoken to fit its slot
GAP_S = 0.1  # left between one spoken phrase and the next
EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}

# Estimated charges, from Azure's list prices (pay as you go); check Azure's pricing pages before relying on them.
# Speech to text is billed per second of audio; text to speech and Translator per character.
TRANSCRIBE_USD_PER_HOUR = 1.00  # standard speech to text; fast transcription is priced at or below this
TTS_USD_PER_M_CHARS = 15.00  # neural voices
TRANSLATE_USD_PER_M_CHARS = 10.00  # Translator, standard

ID = re.compile(r"^[0-9a-f]{32}$")


def find_tool(name: str) -> str | None:
    """ffmpeg or ffprobe on the PATH, or Homebrew's copy."""
    return shutil.which(name) or next((p for p in (f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}")
                                       if Path(p).exists()), None)


def fit_rate(natural_s: float, slot_s: float) -> float:
    """How much faster to speak a phrase so it fits its slot: 1.0 when it fits already, never above MAX_RATE."""
    if slot_s <= 0 or natural_s <= slot_s:
        return 1.0
    return round(min(MAX_RATE, natural_s / slot_s), 2)


def wav_seconds(data: bytes) -> float:
    with wave.open(BytesIO(data)) as w:
        return w.getnframes() / float(w.getframerate())


def segments_from(result: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    """Timed phrases from a fast-transcription result, and the language most of the speech was in."""
    segments, seconds_by_locale = [], {}
    for p in result.get("phrases", []):
        text = (p.get("text") or "").strip()
        if not text:
            continue
        start = p.get("offsetMilliseconds", 0) / 1000
        end = start + p.get("durationMilliseconds", 0) / 1000
        locale = p.get("locale") or ""
        seconds_by_locale[locale] = seconds_by_locale.get(locale, 0) + (end - start)
        segments.append({"start": round(start, 2), "end": round(end, 2), "source_text": text, "locale": locale})
    main = max(seconds_by_locale, key=seconds_by_locale.get) if seconds_by_locale else ""
    return segments, main


def slots(segments: list[dict[str, Any]], duration_s: float) -> list[float]:
    """The time each phrase may take when spoken: up to the next phrase's start, or the end of the video."""
    out = []
    for i, s in enumerate(segments):
        until = segments[i + 1]["start"] if i + 1 < len(segments) else max(duration_s, s["end"])
        out.append(max(0.3, until - s["start"] - GAP_S))
    return out


def ssml(text: str, code: str, rate: float) -> str:
    _, locale, voice = LANGUAGES[code]
    return (f"<speak version='1.0' xml:lang='{locale}'><voice name='{voice}'>"
            f"<prosody rate='{(rate - 1) * 100:+.0f}%'>{escape(text)}</prosody></voice></speak>")


def code_of(locale: str) -> str:
    return LOCALE_TO_CODE.get(locale) or next((c for c in LANGUAGES if locale.lower().startswith(c.lower())), "")


class VideoTranslateService:
    def __init__(self, speech: SpeechRest | None, translator: Any, spend: SpendTracker, streamer: RunStreamer | None,
                 root: Path, ffmpeg: str | None = None, ffprobe: str | None = None):
        self.speech, self.translator, self.spend, self.streamer, self.root = speech, translator, spend, streamer, root
        self.ffmpeg, self.ffprobe = ffmpeg or find_tool("ffmpeg"), ffprobe or find_tool("ffprobe")
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def info(self) -> dict[str, Any]:
        return {"languages": [{"code": c, "name": n, "voice": v} for c, (n, _, v) in LANGUAGES.items()],
                "max_mb": MAX_BYTES // 2**20, "max_seconds": MAX_SECONDS, "max_rate": MAX_RATE,
                "ready": bool(self.speech and self.translator and self.ffmpeg and self.ffprobe),
                "missing": [n for n, ok in (("AZURE_LANGUAGE_ENDPOINT", self.speech and self.translator),
                                            ("ffmpeg", self.ffmpeg and self.ffprobe)) if not ok]}

    # ----- uploads -----

    def _dir(self, vid: str) -> Path:
        if not ID.match(vid or "") or not (self.root / vid / "meta.json").exists():
            raise ApiError(404, "not_found", "That video is no longer here. Upload it again.")
        return self.root / vid

    def _meta(self, vid: str) -> dict[str, Any]:
        return json.loads((self._dir(vid) / "meta.json").read_text())

    def duration(self, path: Path) -> float:
        out = subprocess.run([self.ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                              str(path)], capture_output=True, text=True, timeout=30)
        try:
            return float(out.stdout.strip())
        except ValueError:
            raise ApiError(400, "invalid_request", "That file is not a video ffmpeg can read.") from None

    def upload(self, name: str, stream: BinaryIO) -> dict[str, Any]:
        """Saves the video, refusing it past MAX_BYTES or MAX_SECONDS. Nothing is sent to Azure yet."""
        if not (self.ffmpeg and self.ffprobe):
            raise ApiError(503, "not_configured", "Video translation needs ffmpeg on this machine (brew install ffmpeg).")
        ext = Path(name or "").suffix.lower()
        if ext not in EXTENSIONS:
            raise ApiError(400, "invalid_request", f"Upload a video: {', '.join(sorted(EXTENSIONS))}.")
        vid = uuid.uuid4().hex
        folder = self.root / vid
        folder.mkdir(parents=True)
        source, size = folder / f"source{ext}", 0
        try:
            with source.open("wb") as out:
                while chunk := stream.read(1 << 20):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ApiError(413, "too_large", f"Videos up to {MAX_BYTES // 2**20} MB, please.")
                    out.write(chunk)
            seconds = self.duration(source)
            if seconds > MAX_SECONDS:
                raise ApiError(400, "too_long", f"Videos up to {MAX_SECONDS // 60} minutes, please: this one is "
                                                f"{seconds / 60:.1f} minutes. Trim it and upload it again.")
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        meta = {"id": vid, "name": Path(name).name[:120], "ext": ext, "bytes": size, "duration_s": round(seconds, 2)}
        (folder / "meta.json").write_text(json.dumps(meta))
        self._prune()
        return meta

    def _prune(self) -> None:
        folders = sorted((p for p in self.root.iterdir() if (p / "meta.json").exists()), key=lambda p: p.stat().st_mtime)
        for old in folders[:-KEEP_UPLOADS]:
            shutil.rmtree(old, ignore_errors=True)

    def source(self, vid: str) -> tuple[Path, str]:
        meta = self._meta(vid)
        media = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
                 ".mkv": "video/x-matroska"}[meta["ext"]]
        return self._dir(vid) / f"source{meta['ext']}", media

    def voice_file(self, vid: str, code: str, index: int) -> Path:
        if code not in LANGUAGES:
            raise ApiError(404, "not_found", "No such language.")
        path = self._dir(vid) / "voice" / code / f"{int(index)}.wav"
        if not path.exists():
            raise ApiError(404, "not_found", "That speech has not been made.")
        return path

    # ----- the work -----

    def _lock(self, vid: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(vid, threading.Lock())

    def translate_stream(self, vid: str, code: str, voice: bool) -> Iterator[str]:
        """The run as NDJSON: each step as it happens, then the timed, translated phrases."""
        self._dir(vid)
        if code not in LANGUAGES:
            raise ApiError(400, "invalid_request", "Choose one of the languages offered.")
        if not (self.speech and self.translator):
            raise ApiError(503, "not_configured", "Video translation needs AZURE_LANGUAGE_ENDPOINT (an AI Services "
                                                  "account) in .env, and `az login`.")
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        run = Run()
        return self.streamer.lines(run, lambda: self._work(run, vid, code, voice))

    def _work(self, run: Run, vid: str, code: str, voice: bool) -> None:
        with self._lock(vid):
            try:
                result = self.run(vid, code, voice, run.publish, run.cancelled.is_set)
            except (ApiError, SpeechRestError) as exc:
                run.publish({"type": "error", "message": getattr(exc, "message", str(exc))})
                return
            run.publish({"type": "done", **result})

    def run(self, vid: str, code: str, voice: bool, emit: Callable[[dict], None] = lambda e: None,
            cancelled: Callable[[], bool] = lambda: False) -> dict[str, Any]:
        """Everything for one language, reusing whatever an earlier run already made."""
        folder, meta = self._dir(vid), self._meta(vid)
        cost = 0.0
        transcript = folder / "transcript.json"
        if transcript.exists():
            data = json.loads(transcript.read_text())
        else:
            emit({"type": "step", "step": "extracting", "text": "Taking the sound out of the video"})
            wav = folder / "audio.wav"
            done = subprocess.run([self.ffmpeg, "-loglevel", "error", "-y", "-i", str(folder / f"source{meta['ext']}"),
                                   "-vn", "-ac", "1", "-ar", "16000", "-t", str(MAX_SECONDS), str(wav)],
                                  capture_output=True, text=True, timeout=120)
            if done.returncode != 0 or not wav.exists():
                raise ApiError(400, "invalid_request", "This video has no sound track ffmpeg can read.")
            emit({"type": "step", "step": "transcribing", "text": "Writing down what is said, and finding the language"})
            raw = self.speech.transcribe(wav.read_bytes(), [loc for _, loc, _ in LANGUAGES.values()])
            cost += self.spend.charge_usd(meta["duration_s"] / 3600 * TRANSCRIBE_USD_PER_HOUR,
                                          "Azure Speech fast transcription")
            segments, locale = segments_from(raw)
            data = {"segments": segments, "locale": locale, "code": code_of(locale)}
            transcript.write_text(json.dumps(data, ensure_ascii=False))
        segments, source_code = data["segments"], data["code"]
        detected = {"code": source_code, "locale": data["locale"],
                    "name": LANGUAGES[source_code][0] if source_code in LANGUAGES else data["locale"] or "unknown"}
        emit({"type": "transcript", "detected": detected, "segments": len(segments)})
        if not segments:
            return {"id": vid, "detected": detected, "language": {"code": code, "name": LANGUAGES[code][0]},
                    "segments": [], "voice": False, "duration_s": meta["duration_s"], "cost_usd": round(cost, 6),
                    "note": "No speech was found in this video."}

        # Translate, once per language.
        saved = folder / "translations" / f"{code}.json"
        if saved.exists():
            texts = json.loads(saved.read_text())
        else:
            texts, chars = [], 0
            for i, s in enumerate(segments):
                if cancelled():
                    raise ApiError(499, "cancelled", "Stopped.")
                emit({"type": "step", "step": "translating", "done": i, "total": len(segments),
                      "text": f"Translating phrase {i + 1} of {len(segments)}"})
                if code == source_code:
                    texts.append(s["source_text"])
                    continue
                texts.append(self.translator.translate(s["source_text"], code, source_code or None))
                chars += len(s["source_text"])
            if chars:
                cost += self.spend.charge_usd(chars / 1e6 * TRANSLATE_USD_PER_M_CHARS, "Azure Translator")
            saved.parent.mkdir(exist_ok=True)
            saved.write_text(json.dumps(texts, ensure_ascii=False))
        out = [{**s, "text": t} for s, t in zip(segments, texts)]

        # Speak, once per language: each phrase in its slot.
        if voice:
            vdir = folder / "voice" / code
            index_file = vdir / "index.json"
            if index_file.exists():
                spoken = json.loads(index_file.read_text())
            else:
                vdir.mkdir(parents=True, exist_ok=True)
                spoken, chars = [], 0
                for i, (s, room) in enumerate(zip(out, slots(out, meta["duration_s"]))):
                    if cancelled():
                        raise ApiError(499, "cancelled", "Stopped.")
                    emit({"type": "step", "step": "voicing", "done": i, "total": len(out),
                          "text": f"Speaking phrase {i + 1} of {len(out)} in {LANGUAGES[code][0]}"})
                    audio = self.speech.synthesize(ssml(s["text"], code, 1.0))
                    chars += len(s["text"])
                    natural, rate = wav_seconds(audio), 1.0
                    rate = fit_rate(natural, room)
                    if rate > 1.0:  # too long for its slot: say it again, faster
                        audio = self.speech.synthesize(ssml(s["text"], code, rate))
                        chars += len(s["text"])
                    (vdir / f"{i}.wav").write_bytes(audio)
                    spoken.append({"seconds": round(wav_seconds(audio), 2), "rate": rate})
                cost += self.spend.charge_usd(chars / 1e6 * TTS_USD_PER_M_CHARS, "Azure neural text to speech")
                index_file.write_text(json.dumps(spoken))
            for i, (s, v) in enumerate(zip(out, spoken)):
                s.update({"audio": f"/api/video-translate/media/{vid}/voice/{code}/{i}", "audio_s": v["seconds"],
                          "rate": v["rate"]})
        return {"id": vid, "detected": detected, "language": {"code": code, "name": LANGUAGES[code][0]},
                "segments": out, "voice": voice, "duration_s": meta["duration_s"], "cost_usd": round(cost, 6)}
