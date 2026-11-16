"""Turn detection: deciding when the person has finished speaking, from voice activity, silence and the words so far.

A fixed silence timeout is a bad end-of-turn rule. Too short and it cuts people off mid-thought; too long and every
reply feels slow. This detector watches three things:

  * voice activity: speech started, speech stopped (from the page's voice detector and the recogniser's partial text),
  * silence: how long since the last sign of speech,
  * a cheap text check: does what was said so far sound finished? "What time do you open?" does; "I want to ask about
    the" does not.

It emits the four events a conversation-native speech model emits:

  StartOfTurn       the person started speaking
  EagerEndOfTurn    probably finished: the reply can start now, speculatively, and be thrown away if they go on
  TurnResumed       they kept talking after an eager end: the speculative reply is cancelled, nothing was spoken
  EndOfTurn         finished: the reply is committed

The detector is a plain state machine with no clock of its own: every call carries `now` in milliseconds, so tests drive
it with made-up times. A real clock calls poll() often (the service does, every 25 ms).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

START, EAGER, RESUMED, END = "StartOfTurn", "EagerEndOfTurn", "TurnResumed", "EndOfTurn"
MIN_EAGER_SILENCE_MS = 150  # never speculate on less silence than this: it is the gap between two words
MIN_END_SILENCE_MS = 250  # the shortest end-of-turn wait, for a sentence that clearly finished
UNFINISHED_FACTOR = 1.6  # a sentence that sounds unfinished waits this much longer
NO_SPEECH_TIMEOUT_MS = 3000  # a turn that starts and never gets a word is dropped
MAX_END_SILENCE_MS = 3000

# Words a finished sentence does not end on.
TRAILING = {"and", "but", "or", "so", "because", "if", "when", "while", "that", "which", "who", "to", "of", "for", "with",
            "in", "on", "at", "the", "a", "an", "my", "your", "our", "their", "his", "her", "is", "are", "was", "were",
            "um", "uh", "er", "erm", "like", "then", "also", "about", "from", "by", "as", "than", "i", "i'm", "it's",
            "what", "where", "how", "why", "can", "could", "would", "should", "will", "do", "does", "did", "have",
            "has", "not", "no", "or", "plus", "well", "actually", "basically", "just", "be", "been", "being", "get",
            "go", "going", "want", "need", "think", "know", "mean", "maybe", "should've", "could've", "would've"}
OPENERS = {"i", "so", "and", "but", "well", "um", "uh", "okay", "ok", "right", "yes", "no", "yeah", "hello", "hi", "hey"}


def completeness(text: str) -> float:
    """How finished the words sound, from 0 to 1. A text check, not understanding: punctuation the recogniser added,
    a last word that cannot end a sentence, and how short the turn is."""
    words = re.findall(r"[\w'’£$€%.:/-]+", text.lower())
    if not words:
        return 0.0
    last = words[-1].strip(".,!?'’")
    # Recognisers give partial text without punctuation, so a longer run of words with a sensible last word counts too.
    score = 0.45 if len(words) <= 2 else min(0.8, 0.45 + 0.05 * len(words))
    stripped = text.rstrip()
    if stripped.endswith(("?", "!")):
        score = 0.95
    elif stripped.endswith("."):
        score = 0.9
    elif stripped.endswith((",", "—", "-", "…")):
        score = 0.15
    if last in TRAILING:
        score = min(score, 0.25) if not stripped.endswith(("?", "!", ".")) else score - 0.1
    if len(words) <= 2 and words[0].strip(".,!?") not in OPENERS | {"yes", "no", "thanks", "stop", "wait", "hello"}:
        score -= 0.1
    if len(words) == 1 and last in {"yes", "no", "yeah", "thanks", "stop", "okay", "ok", "hello", "hi"}:
        score = max(score, 0.8)
    if re.search(r"\d\s*$", stripped) and (len(words) <= 4 or re.search(r"number|card|account|phone|code|reference|postcode", text, re.I)):
        score = min(score, 0.3)  # a number may be a card or a phone number still being read out
    return round(max(0.0, min(1.0, score)), 2)


@dataclass
class TurnEvent:
    event: str
    at_ms: float
    text: str = ""
    silence_ms: float = 0.0
    completeness: float = 0.0
    turn: int = 0

    def as_dict(self) -> dict:
        return {"event": self.event, "at_ms": round(self.at_ms), "text": self.text, "silence_ms": round(self.silence_ms),
                "completeness": self.completeness, "turn": self.turn}


@dataclass
class TurnSettings:
    end_silence_ms: int = 700
    eager_threshold: float = 0.6


@dataclass
class TurnDetector:
    settings: TurnSettings = field(default_factory=TurnSettings)
    turn: int = 0
    in_turn: bool = False
    voiced: bool = False  # the voice detector hears speech right now
    eager_text: str | None = None  # the text an eager end was raised on, until the turn ends or resumes
    finals: list[str] = field(default_factory=list)
    partial: str = ""
    last_activity: float = 0.0
    started_at: float = 0.0
    speech_ended_at: float | None = None
    ended_text: str = ""  # what the last turn ended on: the recogniser's late final for it is not new speech
    ended_at: float = -1e9

    # ----------------------------------------------------------------------------------------------- inputs

    @property
    def text(self) -> str:
        """Everything heard this turn: the finished sentences and the one still being recognised."""
        return " ".join(p for p in [*self.finals, self.partial] if p).strip()

    def speech_start(self, now: float) -> list[TurnEvent]:
        self.voiced = True
        self.speech_ended_at = None
        return self._activity(now)

    def speech_end(self, now: float) -> list[TurnEvent]:
        self.voiced = False
        self.speech_ended_at = now
        self.last_activity = max(self.last_activity, now)
        return []

    @staticmethod
    def _plain(text: str) -> str:
        return re.sub(r"[^\w ]", "", text.lower()).strip()

    def _already_heard(self, text: str, now: float) -> bool:
        """The recogniser repeats what it already gave us: a final for words that were partials, or a late final for a
        turn that has ended. That is not the person speaking again."""
        # A repeat is the same words from the start, never any substring: "no" after "I do not know" is a new answer,
        # and "open" after "is the shop open" is the caller carrying on. Text with no words at all is noise.
        def repeat_of(old: str) -> bool:
            new_words, old_words = self._plain(text).split(), self._plain(old).split()
            return not new_words or old_words[:len(new_words)] == new_words

        if self.in_turn and self.eager_text is not None:
            return repeat_of(self.eager_text)
        if not self.in_turn:
            return now - self.ended_at < 4000 and repeat_of(self.ended_text)
        return False

    def partial_text(self, text: str, now: float) -> list[TurnEvent]:
        text = text.strip()
        if not text or self._already_heard(text, now):
            return []
        changed = text != self.partial
        self.partial = text
        return self._activity(now) if changed else []

    def final_text(self, text: str, now: float) -> list[TurnEvent]:
        text = text.strip()
        if text and self._already_heard(text, now):
            self.partial = ""
            if self.in_turn and not self._plain(text) in self._plain(" ".join(self.finals)):
                self.finals.append(text)
            return []
        self.partial = ""
        if not text:
            return []
        events = self._activity(now) if not self.in_turn or self.eager_text is not None else []
        self.finals.append(text)
        self.last_activity = max(self.last_activity, now)
        return events

    def _activity(self, now: float) -> list[TurnEvent]:
        events: list[TurnEvent] = []
        if not self.in_turn:
            self.turn += 1
            self.in_turn, self.started_at = True, now
            self.finals, self.eager_text = [], None
            events.append(TurnEvent(START, now, turn=self.turn))
        elif self.eager_text is not None:
            events.append(TurnEvent(RESUMED, now, self.text, turn=self.turn))
            self.eager_text = None
        self.last_activity = now
        return events

    # ------------------------------------------------------------------------------------------------ the clock

    def end_wait_ms(self, score: float) -> float:
        """How long the silence must last for this sentence to end the turn."""
        base = float(min(MAX_END_SILENCE_MS, max(MIN_END_SILENCE_MS, self.settings.end_silence_ms)))
        if score >= 0.9:
            return max(MIN_END_SILENCE_MS, base * 0.5)
        if score < 0.3:
            return min(MAX_END_SILENCE_MS, base * UNFINISHED_FACTOR)
        return base

    def poll(self, now: float) -> list[TurnEvent]:
        if not self.in_turn or self.voiced:
            return []
        silence = now - self.last_activity
        text = self.text
        if not text:
            if now - self.started_at >= NO_SPEECH_TIMEOUT_MS:
                self.in_turn = False
                return []
            return []
        score = completeness(text)
        if silence >= self.end_wait_ms(score):
            event = TurnEvent(END, now, text, silence, score, self.turn)
            self.ended_text, self.ended_at = text, now
            self.in_turn, self.eager_text, self.partial, self.finals = False, None, "", []
            return [event]
        if (self.eager_text is None and silence >= MIN_EAGER_SILENCE_MS and score >= self.settings.eager_threshold):
            self.eager_text = text
            return [TurnEvent(EAGER, now, text, silence, score, self.turn)]
        return []

    def force_end(self, text: str, now: float) -> TurnEvent:
        """A turn that is already complete (typed text, an uploaded recording): ends at once."""
        self.turn += 1 if not self.in_turn else 0
        self.ended_text, self.ended_at = text, now
        self.in_turn, self.eager_text, self.partial, self.finals = False, None, "", []
        return TurnEvent(END, now, text.strip(), 0.0, completeness(text), self.turn)
