"""What the person actually heard when they interrupted: from the milliseconds of audio played, back to text.

The page counts the audio it really played (not the time since the reply began: gaps while the next sentence was
being synthesised do not count). The server knows each piece's text and duration. Whole pieces that finished are
heard. In the piece that was playing, a voice that reports word boundaries gives the exact words; one that does not
(Azure's REST synthesis and the local voice give only the audio) gets a proportional guess: each word's share of the
piece is its length plus a pause after punctuation, a word counts as heard once half of it has played.
This is the equivalent of a speech model's "text spoken" and "text remaining" after an interruption.
"""
from __future__ import annotations

from dataclasses import dataclass, field

PAUSE_WEIGHT = {",": 3, ";": 4, ":": 4, ".": 6, "!": 6, "?": 6, "…": 6}


@dataclass
class Piece:
    text: str  # as written, before normalising
    duration_ms: float  # of the audio; 0 when it was never synthesised
    word_ends_ms: list[float] | None = None  # from the voice, one per word of `text.split()`, when it gives them

    def as_dict(self) -> dict:
        return {"text": self.text, "duration_ms": round(self.duration_ms)}


@dataclass
class Heard:
    spoken: str
    not_spoken: str
    method: str  # "complete", "boundaries", "proportional" or "sent" (no playback figure: what was sent to the page)
    played_ms: float = 0.0
    parts: list[str] = field(default_factory=list)


def word_ends(text: str, duration_ms: float) -> list[float]:
    """When each word of `text.split()` ends, by its share of the audio: its letters plus a pause after punctuation."""
    words = text.split()
    weights = [len(w) + PAUSE_WEIGHT.get(w[-1], 0) if w else 1 for w in words]
    total = sum(weights) or 1
    ends, acc = [], 0.0
    for w in weights:
        acc += w
        ends.append(duration_ms * acc / total)
    return ends


def split_heard(pieces: list[Piece], played_ms: float | None, sent: int | None = None) -> Heard:
    """The text heard and not heard. `pieces` are all the text generated, in order; those with no duration were never
    synthesised. With no played_ms, the first `sent` pieces are taken as heard (the page said nothing)."""
    if played_ms is None:
        count = len(pieces) if sent is None else sent
        spoken = " ".join(p.text for p in pieces[:count]).strip()
        rest = " ".join(p.text for p in pieces[count:]).strip()
        return Heard(spoken, rest, "sent" if rest or sent is not None else "complete")
    played = max(0.0, played_ms)
    spoken: list[str] = []
    method = "complete"
    acc = 0.0
    for i, piece in enumerate(pieces):
        if piece.duration_ms <= 0:
            return Heard(" ".join(spoken).strip(), " ".join(p.text for p in pieces[i:]).strip(), method, played)
        if played >= acc + piece.duration_ms - 1:  # the last millisecond is rounding
            spoken.append(piece.text)
            acc += piece.duration_ms
            continue
        offset = max(0.0, played - acc)
        words = piece.text.split()
        ends = piece.word_ends_ms if piece.word_ends_ms and len(piece.word_ends_ms) == len(words) else word_ends(piece.text, piece.duration_ms)
        method = "boundaries" if piece.word_ends_ms and len(piece.word_ends_ms) == len(words) else "proportional"
        starts = [0.0, *ends[:-1]]
        heard_words = sum(1 for s, e in zip(starts, ends) if offset >= (s + e) / 2)
        if heard_words:
            spoken.append(" ".join(words[:heard_words]))
        rest = [" ".join(words[heard_words:])] + [p.text for p in pieces[i + 1:]]
        return Heard(" ".join(spoken).strip(), " ".join(r for r in rest if r).strip(), method, played)
    return Heard(" ".join(spoken).strip(), "", "complete", played)
