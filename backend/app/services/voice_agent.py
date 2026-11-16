"""The voice agent: a conversation-native voice agent built from parts you can read.

The page listens with the browser's Azure Speech recogniser (streaming partial and final text, and its own voice
activity detector) and plays audio the server sends. Everything that decides what happens next is here:

  * turn-taking (voice_turns.py): StartOfTurn, EagerEndOfTurn, TurnResumed and EndOfTurn from voice activity, silence
    and a text check of whether the sentence sounds finished;
  * speculation: on an eager end the reply starts at once, but its audio is held back. If the person goes on
    (TurnResumed) the reply is cancelled and nothing was spoken. If the turn ends on the same words, the held audio is
    released, so the first sound comes with no wait for the model;
  * a streamed reply cut into pieces (voice_text.Chunker): the first clause is synthesised as soon as it is complete,
    while the model is still writing; the page plays pieces as they arrive;
  * barge-in: the page stops playing the moment the person speaks and reports how many milliseconds it really played;
    voice_heard.py maps that back to text, and history keeps "spoken" and "not spoken" so the next reply's model knows
    what was heard;
  * delivery (voice_prosody.py): each reply starts with a style tag from the model, rules read the caller's words,
    and the plan becomes SSML for an Azure neural voice, or a speed for the local open voice;
  * numbers (voice_text.py): card numbers, phones, dates, money and references are written as words before synthesis.

Conversations live on the server, one Session each, with its own lock, event queue, history and reply threads. A reply
is two threads (the model's stream, and synthesis); cancelling one sets a flag both check, so nothing keeps running and
nothing is emitted after a cancel. Every Claude reply and every synthesis is charged to SpendTracker.

Honest limits: Azure's REST synthesis returns whole audio files per piece with no word boundaries, so "what was heard"
inside the piece that was playing is a proportional estimate; and each piece is a separate request, so the voice
cannot carry a mood across pieces the way a model that speaks in one pass can.
"""
from __future__ import annotations

import base64
import collections
import copy
import io
import logging
import queue
import re
import threading
import time
import uuid
import wave
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Iterator

from ..core.errors import ApiError, describe
from ..gateways.azure_speech_rest import SpeechRest
from ..gateways.claude import MessageSender
from ..gateways.local_tts import LocalSynth
from ..settings import MODELS
from ..shared import CLAUDE_MODEL, DEFAULT_MODEL, HANDBOOK, PRICES, TOOL_PRICES
from .history import no_reply
from .spend import SpendTracker
from .voice_heard import Heard, Piece, split_heard
from .voice_prosody import (LOCAL_VOICES, MAX_EXPRESSIVENESS, TAGS, VOICE_STYLES, Mood, Plan, build_plan, build_ssml,
                            local_speed, parse_tag)
from .voice_text import Chunker, explain, normalise
from .voice_turns import END, EAGER, RESUMED, START, TurnDetector, TurnEvent, TurnSettings

log = logging.getLogger("llm_lab")

MAX_TEXT = 1000
MAX_SPEAK = 400
MAX_HISTORY = 200
HISTORY_WINDOW = 24  # messages sent to the model
MAX_REPLY_TOKENS = 350
MAX_AUDIO_BYTES = 2_000_000
MAX_AUDIO_S = 30.0
MAX_PLAYED_MS = 600_000
MAX_QUEUE = 4000
TICK_S = 0.025
JOIN_S = 3.0
LISTEN_IDLE_S = 900.0
EVICT_AFTER_S = 60.0  # at the cap, only a conversation unused this long may be closed for a new one
LISTENER_STALE_S = 15.0  # a listener silent this long has gone; heartbeats keep a live one well inside it
STT_USD_PER_MS = TOOL_PRICES["stt_realtime_per_hour"] / 3_600_000

# Grounded in the lab's invented Northwind handbook (python/data.py), so policy answers come from a source and are
# never invented. Example card numbers and references are allowed only for things the agent cannot look up, and are
# always called examples: they give the number normaliser something to read.
SYSTEM = """You are Maya, the voice assistant for staff of Northwind, an invented company, talking to an employee on the phone. Answer questions about policy only from the handbook below. If the handbook does not say, say you don't know and suggest asking HR. Never invent a policy figure, limit, date or contact.
You have no account access. Only if the caller asks you to read out something personal you cannot see, such as a card number, phone number, postcode or order reference, make up a plausible example and say it is an example.
Speak the way people talk: short sentences, no lists, no markdown, no emoji, no stage directions. At most three sentences unless asked for more. Write numbers as digits: a normaliser reads them aloud correctly.
Begin every reply with exactly one delivery tag in square brackets, then the reply. Tags: [neutral] [calm] [empathetic] [cheerful] [brisk] [serious]. Choose from how the caller sounds and what they ask: calm for someone upset, empathetic for worry or bad news, brisk for a quick factual question, cheerful for thanks or good news, serious for money, safety or legal matters, neutral otherwise. The tag is never spoken.
If an earlier reply of yours is marked as interrupted, the caller heard only the words before the marker. Do not repeat what they heard. Answer their new words first.

<handbook>
""" + HANDBOOK + """
</handbook>"""


def make_wav(duration_ms: float, rate: int = 16000) -> bytes:
    """Silence of a given length as a WAV file (a stand-in for a voice, and for text with nothing to say)."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * duration_ms / 1000))
    return out.getvalue()


def wav_duration_ms(wav: bytes) -> float:
    try:
        with wave.open(io.BytesIO(wav)) as w:
            return 1000.0 * w.getnframes() / w.getframerate()
    except (wave.Error, EOFError, ZeroDivisionError):
        return len(wav) / 32.0  # 16 kHz, 16-bit, mono


def percentile(values: list[float], p: float) -> float | None:
    """The nearest-rank percentile (p from 0 to 100); None for no values."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, -(-len(ordered) * p // 100))
    return ordered[int(rank) - 1]


def plain(text: str) -> str:
    return re.sub(r"[^\w ]", "", text.lower()).strip()


# ----------------------------------------------------------------------------------------------------- settings

@dataclass
class ConvSettings:
    end_silence_ms: int = 700
    eager_threshold: float = 0.6
    expressiveness: int = 2
    voice: str = "en-GB-SoniaNeural"
    local_voice: str = "bf_emma"
    tts: str = "azure"  # "azure" or "local"
    model: str = DEFAULT_MODEL

    def as_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


def clean_settings(raw: dict[str, Any], base: ConvSettings) -> ConvSettings:
    """`base` with the given fields changed, every one checked. Raises ApiError 422."""
    out = copy.copy(base)
    for key, value in raw.items():
        if value is None:
            continue
        if key == "end_silence_ms" and isinstance(value, int) and 200 <= value <= 3000:
            out.end_silence_ms = value
        elif key == "eager_threshold" and isinstance(value, (int, float)) and 0.3 <= value <= 0.95:
            out.eager_threshold = float(value)
        elif key == "expressiveness" and isinstance(value, int) and 0 <= value <= MAX_EXPRESSIVENESS:
            out.expressiveness = value
        elif key == "voice" and value in VOICE_STYLES:
            out.voice = value
        elif key == "local_voice" and value in LOCAL_VOICES:
            out.local_voice = value
        elif key == "tts" and value in ("azure", "local"):
            out.tts = value
        elif key == "model" and value in MODELS:
            out.model = value
        else:
            raise ApiError(422, "invalid_setting", f"{key} is not allowed or is out of range.")
    return out


def checked_defaults(given: ConvSettings) -> ConvSettings:
    """Defaults from the environment, each checked like a page's setting. One that would be refused (a voice not in
    the table, say) falls back to the built-in default with a warning, because the page sends the defaults back when it
    creates a conversation, and a refused default would make every conversation fail."""
    out = ConvSettings()
    for key, value in given.as_dict().items():
        try:
            out = clean_settings({key: value}, out)
        except ApiError:
            log.warning("voice agent: the default %s=%r is not allowed; using %r", key, value, getattr(out, key))
    return out


# -------------------------------------------------------------------------------------------------------- session

class Session:
    def __init__(self, cid: str, settings: ConvSettings, now: float):
        self.id, self.settings = cid, settings
        self.lock = threading.RLock()
        self.events: queue.Queue[dict[str, Any]] = queue.Queue()
        self.detector = TurnDetector(TurnSettings(settings.end_silence_ms, settings.eager_threshold))
        self.mood = Mood()
        self.history: list[dict[str, Any]] = []
        self.job: ReplyJob | None = None  # the committed reply in flight
        self.spec: ReplyJob | None = None  # the speculative one, held until the turn ends
        self.turns: dict[int, dict[str, float]] = {}  # per turn: start, final, speech_end, end_of_turn
        self.latency: dict[int, dict[str, Any]] = {}
        self.jobs: list[ReplyJob] = []
        self.listener = False
        self.listener_token = ""  # which claim holds the stream, so an old stream cannot release a newer one
        self.listener_seen = now  # when the listener last asked for an event
        self.unread: collections.deque[dict[str, Any]] = collections.deque()  # popped but never delivered
        self.wakers: set[Callable[[], None]] = set()  # called on every event, so a listener waits without a thread
        self.closed = False
        self.touched = now
        self.created = now
        self.reply_n = 0
        self.speech_end_at: float | None = None
        self.wasted = {"replies": 0, "chars": 0}

    def emit(self, event: dict[str, Any], now: float | None = None) -> None:
        if self.events.qsize() >= MAX_QUEUE:  # a page that stopped reading: drop the oldest, never block a reply
            try:
                self.events.get_nowait()
            except queue.Empty:
                pass
        self.events.put({**event, "t": round(((now if now is not None else time.monotonic() * 1000) - self.created))})
        for wake in list(self.wakers):
            try:
                wake()
            except RuntimeError:  # the listener's event loop has closed
                self.wakers.discard(wake)

    def public_history(self) -> list[dict[str, Any]]:
        out = []
        for e in self.history:
            item = {k: v for k, v in e.items() if k != "chunks"}
            out.append(item)
        return out


# ------------------------------------------------------------------------------------------------------- a reply

class ReplyJob:
    """One reply: the model's stream and synthesis, as two threads that stop together."""

    def __init__(self, svc: "VoiceAgentService", session: Session, user_text: str, turn: int, speculative: bool,
                 history: list[dict[str, Any]]):
        self.svc, self.s = svc, session
        session.reply_n += 1
        self.id = f"r{session.reply_n}"
        self.user_text, self.turn, self.speculative = user_text, turn, speculative
        self.committed = not speculative
        self.settings = copy.copy(session.settings)
        self.history = history
        self.mood = copy.copy(session.mood)
        self.halt = threading.Event()  # both threads stop when it is set
        self.cancelled = False  # stopped from outside: nothing more may be emitted or written
        self.reason = ""
        self.finalised = False
        self.done = False
        self.error: str | None = None
        self.text = ""
        self.pieces: list[Piece] = []
        self.sent: set[int] = set()
        self.plan: Plan | None = None
        self.model_tag: str | None = None
        self.stop_reason: str | None = None
        self.buffer: list[dict[str, Any]] = []
        self.pieceq: queue.Queue[tuple[int, str, bool] | None] = queue.Queue()
        self.marks: dict[str, float] = {"start": svc.clock()}
        self._alive = 2
        self.llm = threading.Thread(target=self._llm, name=f"voice-agent-llm-{session.id}-{self.id}", daemon=True)
        self.tts = threading.Thread(target=self._synth, name=f"voice-agent-tts-{session.id}-{self.id}", daemon=True)

    def start(self) -> None:
        self.llm.start()
        self.tts.start()

    def alive(self) -> bool:
        return self.llm.is_alive() or self.tts.is_alive()

    def join(self, timeout: float = JOIN_S) -> None:
        deadline = time.monotonic() + timeout
        for t in (self.llm, self.tts):
            if t.is_alive() and t is not threading.current_thread():
                t.join(max(0.0, deadline - time.monotonic()))

    # --- emitting: held back until the turn is committed, never after a cancel

    def emit(self, event: dict[str, Any], force: bool = False) -> bool:
        with self.s.lock:
            if self.cancelled and not force:
                return False
            event = {"reply_id": self.id, "turn": self.turn, "speculative": not self.committed, **event}
            if self.committed:
                self._release(event)
            else:
                self.buffer.append(event)
            return True

    def _release(self, event: dict[str, Any]) -> None:
        if event["type"] == "audio":
            self.sent.add(event["index"])
            self.marks.setdefault("audio_sent", self.svc.clock())
        event["speculative"] = False
        self.s.emit(event, self.svc.clock())

    def commit(self) -> None:
        """The turn ended on these words: release what was held, in order."""
        with self.s.lock:
            self.committed = True
            self.marks["commit"] = self.svc.clock()
            held, self.buffer = self.buffer, []
            for event in held:
                self._release(event)

    def sent_count(self) -> int:
        n = 0
        while n in self.sent:
            n += 1
        return n

    # --- the model's stream

    def _fail(self, exc: BaseException) -> None:
        self.error = describe(exc) if isinstance(exc, Exception) else str(exc)
        log.warning("Voice agent reply failed: %s", self.error)
        self.halt.set()
        self.pieceq.put(None)

    def _queue_piece(self, text: str, last: bool = False) -> None:
        with self.s.lock:
            if self.cancelled:
                return
            index = len(self.pieces)
            self.pieces.append(Piece(text, 0.0))
            self.marks.setdefault("first_sentence", self.svc.clock())
        self.emit({"type": "sentence", "index": index, "text": text})
        self.pieceq.put((index, text, last))

    def _decide_plan(self, tag: str | None) -> None:
        self.model_tag = tag
        chosen, source, reason = self.mood.choose(self.user_text, tag)
        self.plan = build_plan(chosen, self.settings.voice, self.settings.expressiveness, source, reason)
        self.emit({"type": "plan", "plan": self.plan.as_dict(), "model_tag": tag, "voice": self.settings.voice,
                   "tts": self.settings.tts})

    def _llm(self) -> None:
        try:
            self._stream()
        except Exception as exc:  # noqa: BLE001  (an API error part-way through: kept as the reply's error)
            self._fail(exc)
        finally:
            self.pieceq.put(None)
            self._thread_ended()

    def _stream(self) -> None:
        if self.svc.spend.over_budget:
            raise ApiError(402, "over_budget", "The spending cap for this session has been reached.")
        messages = build_messages(self.history, self.user_text)
        params = {"model": self.settings.model, "max_tokens": MAX_REPLY_TOKENS, "system": SYSTEM, "messages": messages}
        chunker, head, decided, final = Chunker(), "", False, None
        try:
            with self.svc.claude.stream(**params) as stream:
                for delta in stream.text_stream:
                    if self.halt.is_set():
                        break
                    self.marks.setdefault("first_token", self.svc.clock())
                    if not decided:
                        head += delta
                        tag, rest, decided = parse_tag(head)
                        if not decided:
                            continue
                        self._decide_plan(tag)
                        delta = rest
                    self._add_text(chunker, delta)
                else:
                    final = stream.get_final_message()
        except Exception:
            self.svc.estimate_charge(self.settings.model, messages, self.text)
            raise
        if final is None:  # stopped from outside: the stream never finished, so its usage is not known
            self.svc.estimate_charge(self.settings.model, messages, self.text)
            return
        self.svc.spend.charge(final, self.settings.model)
        self.stop_reason = getattr(final, "stop_reason", None)
        if not decided and not self.halt.is_set():
            tag, rest, _ = parse_tag(head + " ")
            self._decide_plan(tag)
            self._add_text(chunker, rest)
        if self.halt.is_set():
            return
        tail = chunker.flush()
        for i, piece in enumerate(tail):
            self._queue_piece(piece, last=i == len(tail) - 1)
        if not self.text.strip():
            raise RuntimeError(no_reply(final)[1:-1] if self.stop_reason else "The model sent an empty reply.")
        self.marks["llm_done"] = self.svc.clock()

    def _add_text(self, chunker: Chunker, delta: str) -> None:
        self.text += delta
        for piece in chunker.feed(delta):
            self._queue_piece(piece)

    # --- synthesis

    def _synth(self) -> None:
        try:
            while True:
                item = self.pieceq.get()
                if item is None or self.halt.is_set():
                    break
                index, text, last = item
                if self.plan is None:
                    break
                started = self.svc.clock()
                wav, norm = self.svc.synthesize(text, self.settings, self.plan, last)
                took = self.svc.clock() - started
                duration = wav_duration_ms(wav)
                with self.s.lock:
                    if self.cancelled:
                        break
                    self.pieces[index].duration_ms = duration
                    self.marks.setdefault("audio_ready", self.svc.clock())
                self.emit({"type": "audio", "index": index, "text": text, "spoken_as": norm, "duration_ms": round(duration),
                           "tts_ms": round(took), "audio": base64.b64encode(wav).decode(), "last": last})
        except Exception as exc:  # noqa: BLE001
            self._fail(exc)
        finally:
            self._thread_ended()

    def _thread_ended(self) -> None:
        with self.s.lock:
            self._alive -= 1
            if self._alive == 0:
                self.done = True
                self.svc.job_ended(self)

    def cancel(self, reason: str) -> None:
        self.cancelled, self.reason = True, reason
        self.halt.set()
        self.pieceq.put(None)


def build_messages(history: list[dict[str, Any]], new_user: str | None = None) -> list[dict[str, str]]:
    """The model's view of the conversation. An interrupted reply is shown as what was heard, with a marker and what
    was not heard. Turns of the same speaker (a reply that failed, or a second message sent over the first) are
    merged, so the list always alternates and starts and ends with the caller."""
    items: list[tuple[str, str]] = []
    for e in history[-HISTORY_WINDOW:]:
        if e["role"] == "user":
            items.append(("user", e["text"]))
            continue
        spoken, rest = (e.get("spoken") or "").strip(), (e.get("not_spoken") or "").strip()
        if e.get("interrupted"):
            if spoken:
                text = f"{spoken} [The caller interrupted here. They heard only the words above. They did not hear: {rest or 'the rest of the reply'}]"
            else:
                text = f"[The caller interrupted before hearing any of this reply. They did not hear: {rest or e['text']}]"
        elif e.get("error"):
            text = f"{e['text']} [This reply was cut off by a technical fault.]"
        else:
            text = e["text"]
        if text.strip():
            items.append(("assistant", text))
    if new_user is not None:
        items.append(("user", new_user))
    merged: list[dict[str, str]] = []
    for role, text in items:
        if merged and merged[-1]["role"] == role:
            merged[-1]["content"] += "\n" + text
        else:
            merged.append({"role": role, "content": text})
    while merged and merged[0]["role"] != "user":
        merged.pop(0)
    while merged and merged[-1]["role"] != "user":
        merged.pop()
    return merged or [{"role": "user", "content": "Hello."}]


# ---------------------------------------------------------------------------------------------------- the service

class VoiceAgentService:
    def __init__(self, claude: MessageSender, spend: SpendTracker, rest: SpeechRest | None, local: LocalSynth | None,
                 defaults: ConvSettings | None = None, max_conversations: int = 20, clock=None, autopoll: bool = True,
                 heartbeat_s: float = 10.0):
        self.claude, self.spend, self.rest, self.local = claude, spend, rest, local
        self.defaults = checked_defaults(defaults or ConvSettings())
        self.max_conversations, self.autopoll, self.heartbeat_s = max_conversations, autopoll, heartbeat_s
        self._clock = clock
        self.sessions: dict[str, Session] = {}
        self._lock = threading.Lock()
        self._ticker: threading.Thread | None = None
        self._stop = threading.Event()

    def clock(self) -> float:
        """Milliseconds on a monotonic clock (a fake one in tests)."""
        return self._clock() if self._clock else time.monotonic() * 1000

    # --- conversations

    def info(self) -> dict[str, Any]:
        return {
            "defaults": self.defaults.as_dict(), "tags": list(TAGS), "models": MODELS, "claude_model": CLAUDE_MODEL,
            "voices": [{"id": v, "name": v.split("-", 2)[2].replace("Neural", ""), "styles": s} for v, s in VOICE_STYLES.items()],
            "local_voices": [{"id": k, "name": v} for k, v in LOCAL_VOICES.items()],
            "tts": {"azure": {"available": self.rest is not None,
                              "reason": "" if self.rest is not None else "Azure neural voices need AZURE_LANGUAGE_ENDPOINT in .env (the AI Services account's address)."},
                    "local": self.local.status() if self.local else {"installed": False, "running": False,
                                                                       "reason": "The local voice is not set up.", "engine": "Kokoro-82M (ONNX)"}},
            "limits": {"text": MAX_TEXT, "speak": MAX_SPEAK, "audio_bytes": MAX_AUDIO_BYTES, "audio_s": MAX_AUDIO_S,
                       "end_silence_ms": [200, 3000], "eager_threshold": [0.3, 0.95], "expressiveness": [0, MAX_EXPRESSIVENESS]},
            "prices": {"tts_per_1m_chars": TOOL_PRICES["tts_neural_per_1m_chars"], "stt_per_hour": TOOL_PRICES["stt_realtime_per_hour"]},
        }

    def create(self, raw: dict[str, Any] | None = None) -> dict[str, Any]:
        settings = clean_settings(raw or {}, self.defaults)
        now = self.clock()
        with self._lock:
            if len(self.sessions) >= self.max_conversations:
                # Only a conversation nobody is using: no listener, no reply running, and untouched for EVICT_AFTER_S.
                # A page between creating its conversation and opening its stream has no listener yet, and must not be
                # pushed out by another tab or a script creating conversations.
                idle = sorted((s for s in self.sessions.values() if not s.listener and not any(j.alive() for j in s.jobs)
                               and now - s.touched >= EVICT_AFTER_S * 1000), key=lambda s: s.touched)  # the clock counts ms
                if not idle:
                    raise ApiError(429, "too_many_conversations", "Too many voice conversations are open.")
                evicted = idle[0]
            else:
                evicted = None
            cid = uuid.uuid4().hex[:12]
            session = Session(cid, settings, now)
            self.sessions[cid] = session
        if evicted:
            self.close(evicted.id)
        self._start_ticker()
        return {"id": cid, "settings": settings.as_dict()}

    def _get(self, cid: str) -> Session:
        session = self.sessions.get(cid)
        if session is None or session.closed:
            raise ApiError(404, "not_found", "That conversation is not open. Start a new one.")
        return session

    def get(self, cid: str) -> dict[str, Any]:
        s = self._get(cid)
        with s.lock:
            return {"id": s.id, "settings": s.settings.as_dict(), "history": s.public_history(), "latency": self._stats(s),
                    "mood": s.mood.tag, "wasted": dict(s.wasted)}

    def update_settings(self, cid: str, raw: dict[str, Any]) -> dict[str, Any]:
        s = self._get(cid)
        with s.lock:
            s.settings = clean_settings(raw, s.settings)
            s.detector.settings = TurnSettings(s.settings.end_silence_ms, s.settings.eager_threshold)
            return s.settings.as_dict()

    def close(self, cid: str) -> None:
        with self._lock:
            s = self.sessions.pop(cid, None)
        if s is None:
            return
        with s.lock:
            s.closed = True
            for job in list(s.jobs):
                if not job.finalised:
                    self._cancel(s, job, "closed", None)
            s.emit({"type": "closed"})
            jobs = list(s.jobs)
        for job in jobs:
            job.join()

    def shutdown(self) -> None:
        """The server is stopping: cancel every reply (they keep paying for model and voice calls otherwise), close the
        conversations, and stop the local voice server so a reload does not find it still holding the port."""
        self._stop.set()
        try:
            for cid in list(self.sessions):
                self.close(cid)
        finally:
            if self.local is not None:
                self.local.stop()

    def wait_idle(self, cid: str, timeout: float = 5.0) -> bool:
        """Waits for every reply thread of a conversation to stop. True when none is left."""
        s = self._get(cid)
        deadline = time.monotonic() + timeout
        for job in list(s.jobs):
            job.join(max(0.0, deadline - time.monotonic()))
        return not any(j.alive() for j in s.jobs)

    # --- the event stream

    def claim(self, cid: str) -> Session:
        """Take the conversation's event stream. A listener that has not asked for an event for LISTENER_STALE_S is
        gone (its client left before the stream started, so it never released), and can be taken over."""
        s = self._get(cid)
        with s.lock:
            if s.listener and self.clock() - s.listener_seen < LISTENER_STALE_S * 1000:  # the clock counts ms
                raise ApiError(409, "already_listening", "Another tab is already listening to this conversation.")
            s.listener = True
            s.listener_token = uuid.uuid4().hex
            s.listener_seen = self.clock()
            s.touched = self.clock()
            s.emit({"type": "ready", "settings": s.settings.as_dict(), "history": s.public_history()})
        return s

    def release(self, s: Session, token: str | None = None) -> None:
        with s.lock:
            if token is None or token == s.listener_token:
                s.listener = False

    def next_event(self, s: Session, timeout: float = 0.0) -> dict[str, Any] | None:
        """The next event, or None. A timeout of 0 never blocks, which is how the event stream asks (see watch)."""
        with s.lock:
            s.listener_seen = self.clock()
            if s.unread:
                return s.unread.popleft()
        try:
            return s.events.get(timeout=timeout) if timeout > 0 else s.events.get_nowait()
        except queue.Empty:
            return None

    def watch(self, s: Session, wake: Callable[[], None]) -> None:
        """Call `wake` (from whichever thread emits) on each new event, until unwatch."""
        with s.lock:
            s.wakers.add(wake)

    def unwatch(self, s: Session, wake: Callable[[], None]) -> None:
        with s.lock:
            s.wakers.discard(wake)

    def unread(self, s: Session, event: dict[str, Any]) -> None:
        """Put back an event that was taken from the queue but never reached the page, so a reconnect gets it."""
        with s.lock:
            s.unread.appendleft(event)

    def drain(self, cid: str) -> list[dict[str, Any]]:
        """Every event waiting (for tests and the smoke test)."""
        s = self._get(cid)
        out = []
        while True:
            try:
                out.append(s.events.get_nowait())
            except queue.Empty:
                return out

    # --- the clock

    def _start_ticker(self) -> None:
        if not self.autopoll or (self._ticker and self._ticker.is_alive()):
            return
        self._stop.clear()
        self._ticker = threading.Thread(target=self._tick, name="voice-agent-clock", daemon=True)
        self._ticker.start()

    def expire_idle(self) -> list[str]:
        """Closes conversations nobody has used for LISTEN_IDLE_S (no input and no reply running), so a page that went
        without closing, or a script creating conversations, does not hold one until the cap pushes it out."""
        now = self.clock()
        idle = [s.id for s in list(self.sessions.values())
                if now - s.touched >= LISTEN_IDLE_S * 1000 and not any(j.alive() for j in s.jobs)]  # the clock counts ms
        for cid in idle:
            self.close(cid)
        return idle

    def _tick(self) -> None:
        last_sweep = time.monotonic()
        while not self._stop.wait(TICK_S):
            if time.monotonic() - last_sweep >= 10:
                last_sweep = time.monotonic()
                try:
                    self.expire_idle()
                except Exception:  # noqa: BLE001
                    log.exception("The voice agent could not close idle conversations.")
            for s in list(self.sessions.values()):
                if s.detector.in_turn:
                    try:
                        self.poll(s.id)
                    except ApiError:
                        pass
                    except Exception:  # noqa: BLE001
                        log.exception("The voice agent's clock failed.")

    def poll(self, cid: str) -> None:
        s = self._get(cid)
        with s.lock:
            self._turn_events(s, s.detector.poll(self.clock()), self.clock())

    # --- input from the page

    def handle(self, cid: str, ev: dict[str, Any]) -> dict[str, Any]:
        s = self._get(cid)
        now, kind = self.clock(), ev.get("type")
        with s.lock:
            s.touched = now
            if kind == "speech_start":
                self._turn_events(s, s.detector.speech_start(now), now)
            elif kind == "speech_end":
                s.speech_end_at = now
                s.detector.speech_end(now)
            elif kind == "partial":
                s.emit({"type": "transcript", "partial": True, "text": ev["text"]}, now)
                self._turn_events(s, s.detector.partial_text(ev["text"], now), now)
            elif kind == "final":
                s.emit({"type": "transcript", "partial": False, "text": ev["text"]}, now)
                self._charge_stt(ev.get("audio_ms", 0))
                events = s.detector.final_text(ev["text"], now)
                turn = s.detector.turn
                marks = s.turns.setdefault(turn, {})
                if "final" not in marks or "end_of_turn" not in marks:  # the last final before the turn ended
                    marks["final"] = now
                self._turn_events(s, events, now)
            elif kind == "interrupt":
                return self._interrupt(s, ev["reply_id"], ev["played_ms"])
            elif kind == "playback":
                return self._playback(s, ev["reply_id"], ev["state"], now)
            else:
                raise ApiError(422, "unknown_event", f"Unknown event {kind!r}.")
        return {"ok": True}

    def _charge_stt(self, audio_ms: float) -> None:
        if audio_ms > 0:
            self.spend.charge_usd(audio_ms * STT_USD_PER_MS, "Azure speech to text")

    def text_turn(self, cid: str, text: str) -> dict[str, Any]:
        """A typed turn: a whole turn at once, with no recogniser."""
        s = self._get(cid)
        text = text.strip()
        if not text or len(text) > MAX_TEXT:
            raise ApiError(422, "invalid_text", f"Text must be 1 to {MAX_TEXT} characters.")
        now = self.clock()
        self._whole_turn(s, text, now, now, {})
        return {"ok": True}

    def _whole_turn(self, s: Session, text: str, now: float, started: float, extra: dict[str, Any]) -> None:
        """A turn that arrives complete (typed, or a recording). If the microphone has a turn open, this ends that turn
        with these words, under its number; otherwise it is a new turn that started at `started`. Either way the
        detector is left with no turn open, so the live recogniser's next words start the next turn."""
        with s.lock:
            s.touched = now
            s.emit({"type": "transcript", "partial": False, "text": text, **extra}, now)
            if s.detector.in_turn:
                self._turn_events(s, [s.detector.force_end(text, now)], now)
            else:
                turn = s.detector.turn + 1
                s.turns.setdefault(turn, {})["final"] = now
                self._turn_events(s, [TurnEvent(START, started, turn=turn)], started)
                s.speech_end_at = started
                self._turn_events(s, [s.detector.force_end(text, now)], now)
            s.speech_end_at = None

    def audio_turn(self, cid: str, wav: bytes) -> dict[str, Any]:
        """A recorded turn (a WAV file stands in for the microphone): transcribed, then handled as a finished turn."""
        s = self._get(cid)
        seconds = check_wav(wav)
        if self.rest is None:
            raise ApiError(503, "speech_unavailable", "Transcribing a recording needs AZURE_LANGUAGE_ENDPOINT in .env.")
        received = self.clock()
        try:
            result = self.rest.transcribe(wav, ["en-GB"])
        except Exception as exc:  # noqa: BLE001
            raise ApiError(502, "speech_error", describe(exc)) from exc
        self._charge_stt(seconds * 1000)
        phrases = result.get("combinedPhrases") or [{}]
        text = (phrases[0].get("text") or "").strip()
        now = self.clock()
        if not text:
            raise ApiError(422, "no_speech", "No speech was heard in that recording.")
        self._whole_turn(s, text, now, received, {"transcribe_ms": round(now - received)})
        return {"ok": True, "text": text, "transcribe_ms": round(now - received)}

    # --- turn events

    def _turn_events(self, s: Session, events: list[TurnEvent], now: float) -> None:
        # Called with s.lock held, as close() sets `closed`. A request that found the session open just before close()
        # ran must not start a reply that nothing will cancel or join, and that would go on paying for model calls.
        if s.closed:
            raise ApiError(404, "not_found", "That conversation is not open. Start a new one.")
        for ev in events:
            s.emit({"type": "turn_event", **ev.as_dict()}, now)
            marks = s.turns.setdefault(ev.turn, {})
            if ev.event == START:
                marks["start"] = now
                # speaking over the agent: stop its generation now. The page's own interrupt message, with the
                # milliseconds it really played, follows and refines what was heard.
                if s.job and not s.job.finalised:
                    self._cancel(s, s.job, "barge_in", None)
                if s.spec:
                    self._cancel(s, s.spec, "turn_resumed", None)
            elif ev.event == EAGER:
                marks["eager"] = now
                if s.spec and not s.spec.finalised:
                    self._cancel(s, s.spec, "superseded", None)
                s.spec = self._start(s, ev.text, ev.turn, speculative=True)
            elif ev.event == RESUMED:
                if s.spec:
                    self._cancel(s, s.spec, "turn_resumed", None)
            elif ev.event == END:
                marks["end_of_turn"] = now
                self._end_turn(s, ev, now)

    def _end_turn(self, s: Session, ev: TurnEvent, now: float) -> None:
        marks = s.turns.setdefault(ev.turn, {})
        marks["speech_end"] = s.speech_end_at if s.speech_end_at is not None and s.speech_end_at <= now else now - ev.silence_ms
        text = ev.text.strip()
        if s.job and not s.job.finalised:  # a new turn while a reply is still going: the new one wins
            self._cancel(s, s.job, "superseded", None)
        spec, s.spec = s.spec, None
        if spec and not spec.finalised and plain(spec.user_text) == plain(text):
            self._append_user(s, text, ev.turn)
            s.job = spec
            marks["speculative_used"] = 1.0
            spec.commit()
            self._finalise_if_done(s, spec)
            return
        if spec and not spec.finalised:
            self._cancel(s, spec, "text_changed", None)
        self._append_user(s, text, ev.turn)
        job = self._start(s, text, ev.turn, speculative=False)
        s.job = job

    def _append_user(self, s: Session, text: str, turn: int) -> None:
        s.history.append({"role": "user", "text": text, "turn": turn})
        del s.history[:-MAX_HISTORY]

    def _start(self, s: Session, text: str, turn: int, speculative: bool) -> ReplyJob:
        job = ReplyJob(self, s, text, turn, speculative, list(s.history))
        s.jobs = [j for j in s.jobs if j.alive() or not j.finalised][-20:] + [job]
        s.emit({"type": "reply_start", "reply_id": job.id, "turn": turn, "speculative": speculative,
                "model": job.settings.model}, self.clock())
        job.start()
        return job

    # --- finishing a reply: history is written once, by whoever gets there first

    def job_ended(self, job: ReplyJob) -> None:
        s = job.s
        with s.lock:
            if job.cancelled:
                return
            self._finalise_if_done(s, job)

    def _finalise_if_done(self, s: Session, job: ReplyJob) -> None:
        if not (job.committed and job.done) or job.finalised or job.cancelled:
            return
        job.finalised = True
        # With an error part-way, only the pieces the page was sent can have been heard.
        heard = split_heard(job.pieces, None, sent=job.sent_count() if job.error else None)
        if job.error:
            s.emit({"type": "error", "reply_id": job.id, "turn": job.turn, "message": job.error}, self.clock())
        if job.text.strip():
            entry = self._entry(job, heard, interrupted=False)
            entry["error"] = job.error
            entry["truncated"] = job.stop_reason == "max_tokens"
            s.history.append(entry)
            del s.history[:-MAX_HISTORY]
            s.mood = job.mood
        s.emit({"type": "reply_done", "reply_id": job.id, "turn": job.turn, "text": job.text.strip(), "error": job.error,
                "stop_reason": job.stop_reason}, self.clock())
        self._record_latency(s, job, played=None)
        if s.job is job:
            s.job = None

    def _entry(self, job: ReplyJob, heard: Heard, interrupted: bool) -> dict[str, Any]:
        return {"role": "assistant", "text": job.text.strip(), "reply_id": job.id, "turn": job.turn,
                "spoken": heard.spoken, "not_spoken": heard.not_spoken, "interrupted": interrupted,
                "heard_confirmed": False, "method": heard.method, "plan": job.plan.as_dict() if job.plan else None,
                "model": job.settings.model, "error": None, "chunks": [p.as_dict() for p in job.pieces]}

    def _cancel(self, s: Session, job: ReplyJob, reason: str, played_ms: float | None) -> None:
        """Stops a reply now. A speculative one leaves no trace (nothing was spoken). A committed one is written to
        history as what was generated, with what was heard and what was not."""
        if job.finalised:
            return
        job.cancel(reason)
        job.finalised = True
        if s.spec is job:
            s.spec = None
        if s.job is job:
            s.job = None
        if not job.committed:
            s.wasted["replies"] += 1
            s.wasted["chars"] += len(job.text)
            s.emit({"type": "reply_cancelled", "reply_id": job.id, "turn": job.turn, "speculative": True, "reason": reason,
                    "wasted_chars": len(job.text)}, self.clock())
            return
        heard = split_heard(job.pieces, played_ms, sent=job.sent_count() if played_ms is None else None)
        cut = "llm_done" not in job.marks  # the model was still writing: some of the reply was never generated
        s.emit({"type": "reply_cancelled", "reply_id": job.id, "turn": job.turn, "speculative": False, "reason": reason},
               self.clock())
        if job.text.strip():
            entry = self._entry(job, heard, interrupted=bool(heard.not_spoken) or cut)
            entry["generation_cut"] = cut
            s.history.append(entry)
            del s.history[:-MAX_HISTORY]
            if job.plan is not None:
                s.mood = job.mood
            s.emit({"type": "barge_in", "reply_id": job.id, "turn": job.turn, "reason": reason,
                    "played_ms": round(played_ms) if played_ms is not None else None, "spoken": heard.spoken,
                    "not_spoken": heard.not_spoken, "method": heard.method, "generation_cut": cut}, self.clock())

    def _interrupt(self, s: Session, reply_id: str, played_ms: float) -> dict[str, Any]:
        """The page stopped playing: it says how many milliseconds of audio it really played."""
        job = next((j for j in s.jobs if j.id == reply_id and j.committed), None)
        if job and not job.finalised:
            self._cancel(s, job, "barge_in", played_ms)
            return {"ok": True}
        entry = next((e for e in reversed(s.history) if e.get("reply_id") == reply_id), None)
        if entry is None:
            return {"ok": False}
        pieces = [Piece(c["text"], c["duration_ms"]) for c in entry["chunks"]]
        heard = split_heard(pieces, played_ms)
        if not heard.not_spoken and not entry.get("generation_cut") and entry["interrupted"] is False:
            entry.update(spoken=heard.spoken, heard_confirmed=True)
            return {"ok": True}
        entry.update(spoken=heard.spoken, not_spoken=heard.not_spoken, interrupted=True, method=heard.method,
                     heard_confirmed=True)
        s.emit({"type": "barge_in", "reply_id": reply_id, "turn": entry["turn"], "reason": "barge_in", "played_ms": round(played_ms),
                "spoken": heard.spoken, "not_spoken": heard.not_spoken, "method": heard.method,
                "generation_cut": bool(entry.get("generation_cut"))}, self.clock())
        return {"ok": True}

    def _playback(self, s: Session, reply_id: str, state: str, now: float) -> dict[str, Any]:
        job = next((j for j in s.jobs if j.id == reply_id), None)
        if state == "started" and job is not None and "played" not in job.marks:
            job.marks["played"] = now
            self._record_latency(s, job, played=now)
        elif state == "done":
            entry = next((e for e in reversed(s.history) if e.get("reply_id") == reply_id), None)
            if entry is not None and not entry["interrupted"]:
                entry["heard_confirmed"] = True
        return {"ok": True}

    # --- latency

    def _record_latency(self, s: Session, job: ReplyJob, played: float | None) -> None:
        if not job.committed:
            return
        marks = s.turns.get(job.turn, {})
        t0 = marks.get("speech_end")
        if t0 is None:
            return

        def rel(value: float | None) -> float | None:
            return None if value is None else max(0.0, round(value - t0))
        m = job.marks
        played = played if played is not None else m.get("played")
        row = {"turn": job.turn, "reply_id": job.id, "speculative_used": bool(marks.get("speculative_used")),
               "speech_end": 0, "final": rel(marks.get("final")), "end_of_turn": rel(marks.get("end_of_turn")),
               "first_token": rel(m.get("first_token")), "first_sentence": rel(m.get("first_sentence")),
               "audio_ready": rel(m.get("audio_ready")),
               "first_audio_sent": rel(m.get("audio_sent")),
               "first_audio_played": rel(played)}
        s.latency[job.turn] = row
        s.emit({"type": "latency", **row, "stats": self._stats(s)}, self.clock())

    @staticmethod
    def _stats(s: Session) -> dict[str, Any]:
        values = [r["first_audio_played"] if r["first_audio_played"] is not None else r["first_audio_sent"]
                  for r in s.latency.values()]
        values = [v for v in values if v is not None]
        return {"turns": len(values), "median_ms": percentile(values, 50), "p95_ms": percentile(values, 95)}

    # --- synthesis

    def synthesize(self, text: str, settings: ConvSettings, plan: Plan, last: bool = False) -> tuple[bytes, str]:
        """One piece of reply as a WAV file, and the words it was spoken as. Charged to SpendTracker."""
        if self.spend.over_budget:
            raise ApiError(402, "over_budget", "The spending cap for this session has been reached.")
        spoken = normalise(text)
        if not re.search(r"\w", spoken):  # only punctuation: nothing to say
            return make_wav(60), spoken
        if settings.tts == "local":
            if self.local is None:
                raise ApiError(503, "local_voice", "The local voice is not set up. See examples/voice-agent/README.md.")
            return self.local.synthesize(spoken, settings.local_voice, local_speed(plan)), spoken
        if self.rest is None:
            raise ApiError(503, "speech_unavailable", "Azure neural voices need AZURE_LANGUAGE_ENDPOINT in .env. "
                           "Pick the local voice, or add it and restart the backend.")
        wav = self.rest.synthesize(build_ssml(spoken, settings.voice, plan, last))
        self.spend.charge_usd(len(spoken) * TOOL_PRICES["tts_neural_per_1m_chars"] / 1_000_000, "Azure neural voice")
        return wav, spoken

    def speak(self, text: str, tts: str, voice: str | None, local_voice: str | None, expressiveness: int,
              tag: str) -> dict[str, Any]:
        """The 'read this fast' test: one text, normalised and spoken, with no model and no conversation."""
        text = text.strip()
        if not text or len(text) > MAX_SPEAK:
            raise ApiError(422, "invalid_text", f"Text must be 1 to {MAX_SPEAK} characters.")
        settings = clean_settings({"tts": tts, "voice": voice, "local_voice": local_voice, "expressiveness": expressiveness},
                                  self.defaults)
        plan = build_plan(tag if tag in TAGS else "neutral", settings.voice, settings.expressiveness, "rules", "Chosen on the page.")
        started = self.clock()
        try:
            wav, spoken = self.synthesize(text, settings, plan, last=True)
        except ApiError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ApiError(502, "speech_error", describe(exc)) from exc
        return {"text": text, "spoken_as": spoken, "plan": plan.as_dict(), "tts": settings.tts, "tts_ms": round(self.clock() - started),
                "duration_ms": round(wav_duration_ms(wav)), "audio": base64.b64encode(wav).decode()}

    def estimate_charge(self, model: str, messages: list[dict[str, str]], out: str) -> None:
        """A stream that was stopped or failed never gives its usage: charge an estimate (four characters a token)."""
        price = PRICES.get(model)
        if not price:
            return
        tokens_in = (len(SYSTEM) + sum(len(m["content"]) for m in messages)) / 4
        cost = (tokens_in * price["input"] + len(out) / 4 * price["output"]) / 1_000_000
        self.spend.charge_usd(cost, f"{model} (voice reply stopped early, estimated)")


def check_wav(wav: bytes) -> float:
    """Seconds of audio in an uploaded WAV; raises ApiError 422 when it is not one this page accepts."""
    if len(wav) > MAX_AUDIO_BYTES:
        raise ApiError(413, "too_large", f"The recording is over {MAX_AUDIO_BYTES // 1_000_000} MB.")
    try:
        with wave.open(io.BytesIO(wav)) as w:
            channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    except (wave.Error, EOFError) as exc:
        raise ApiError(422, "not_wav", "Send a PCM WAV file.") from exc
    if channels != 1 or width != 2 or not 8000 <= rate <= 48000:
        raise ApiError(422, "wav_format", "The WAV must be mono, 16-bit, 8 to 48 kHz.")
    seconds = frames / rate
    if seconds < 0.2 or seconds > MAX_AUDIO_S:
        raise ApiError(422, "wav_length", f"The recording must be 0.2 to {MAX_AUDIO_S:.0f} seconds.")
    return seconds


def normalise_report(text: str) -> dict[str, Any]:
    """Before and after, with what changed marked: for the page's normaliser panel."""
    if len(text) > MAX_SPEAK * 2:
        raise ApiError(422, "invalid_text", "Text is too long.")
    segments = explain(text)
    return {"before": text, "after": re.sub(r"[ \t]{2,}", " ", "".join(s.after for s in segments)),
            "segments": [{"kind": s.kind, "before": s.before, "after": s.after} for s in segments]}
