"""The songbird page's composer: a model turns a description ("a slow rising whistle, then a fast trill") into a score
for the page's two-voice syrinx synth. The model writes notes; code checks every one is something a songbird's
syrinx could sing (each side in its own range, no side singing two notes at once, a short song) before the page plays
it, and sends the problems back once for a second try.
"""
from __future__ import annotations

import json
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, text_of
from .spend import SpendTracker

RANGES = {"L": (400.0, 5000.0), "R": (1200.0, 10000.0)}  # Hz: the left side sings lower, the right higher
MAX_SECONDS = 8.0
MAX_NOTES = 120
MIN_NOTE = 0.008  # seconds

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["title", "explanation", "notes"],
    "properties": {
        "title": {"type": "string"},
        "explanation": {"type": "string", "description": "two or three sentences: how the bird sings this, side by side"},
        "notes": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["voice", "start", "duration", "f_start", "f_end", "amplitude", "harmonics", "trill_rate",
                         "trill_depth"],
            "properties": {
                "voice": {"type": "string", "enum": ["L", "R"]},
                "start": {"type": "number"}, "duration": {"type": "number"},
                "f_start": {"type": "number"}, "f_end": {"type": "number"},
                "amplitude": {"type": "number"}, "harmonics": {"type": "number"},
                "trill_rate": {"type": "number"}, "trill_depth": {"type": "number"},
            }}},
    },
}

SYSTEM = f"""You compose bird song for a synthesiser modelled on a songbird's syrinx. The syrinx has two independent
sides, each with its own vibrating folds: L (left) sings low notes, {RANGES['L'][0]:.0f} to {RANGES['L'][1]:.0f} Hz, and
R (right) sings high notes, {RANGES['R'][0]:.0f} to {RANGES['R'][1]:.0f} Hz. Both can sing at once (two notes that are not
harmonics of each other sound like a duet), and one sweep can be handed from one side to the other at about 2.6 to
3.4 kHz. Each side sings one note at a time: notes on the same side must not overlap.

Write the song the person describes as notes. start and duration are seconds (the whole song at most
{MAX_SECONDS:.0f} seconds, at most {MAX_NOTES} notes; trills are many short notes, 15 to 30 a second). f_start and f_end
are the frequency at the note's start and end (a glide when they differ). amplitude is 0 to 1. harmonics is 0 for a pure
whistle up to 1 for a buzzy note. trill_rate (Hz) and trill_depth (fraction of the frequency, up to 0.1) add a warble;
use 0 for none. Leave short gaps between phrases: real birds take mini-breaths there.

Then explain in two or three plain British English sentences how a bird would sing it: which side does what."""


def problems(score: dict[str, Any]) -> list[str]:
    """What is wrong with a score, in words the model can act on. Empty when it can be played."""
    found: list[str] = []
    notes = score.get("notes") or []
    if not notes:
        return ["There are no notes."]
    if len(notes) > MAX_NOTES:
        found.append(f"{len(notes)} notes; the limit is {MAX_NOTES}.")
    for i, n in enumerate(notes):
        low, high = RANGES.get(n.get("voice"), (0, 0))
        for key in ("f_start", "f_end"):
            if not low <= float(n.get(key, 0)) <= high:
                found.append(f"Note {i}: {key} {n.get(key)} Hz is outside the {n.get('voice')} side's range "
                             f"({low:.0f} to {high:.0f} Hz).")
        if float(n.get("duration", 0)) < MIN_NOTE:
            found.append(f"Note {i}: duration {n.get('duration')} s is too short (at least {MIN_NOTE} s).")
        if float(n.get("start", -1)) < 0:
            found.append(f"Note {i}: start is negative.")
        if float(n.get("start", 0)) + float(n.get("duration", 0)) > MAX_SECONDS:
            found.append(f"Note {i} ends after {MAX_SECONDS:.0f} seconds.")
    for side in ("L", "R"):
        own = sorted((n for n in notes if n.get("voice") == side), key=lambda n: n["start"])
        for a, b in zip(own, own[1:]):
            if a["start"] + a["duration"] > b["start"] + 1e-3:
                found.append(f"Two {side} notes overlap at {b['start']:.3f} s; one side sings one note at a time.")
                break
    return found[:12]


def to_page(score: dict[str, Any]) -> list[dict[str, Any]]:
    """The notes in the page's shape, with loudness, harmonics and warble clipped to their ranges."""
    clip = lambda v, lo, hi: max(lo, min(hi, float(v)))  # noqa: E731
    out = []
    for n in sorted(score["notes"], key=lambda n: n["start"]):
        note = {"voice": n["voice"], "t": round(float(n["start"]), 4), "d": round(float(n["duration"]), 4),
                "f0": float(n["f_start"]), "f1": float(n["f_end"]), "amp": clip(n["amplitude"], 0.05, 1),
                "harm": clip(n["harmonics"], 0, 1)}
        if float(n["trill_rate"]) > 0 and float(n["trill_depth"]) > 0:
            note.update(trill=clip(n["trill_rate"], 1, 60), trillDepth=clip(n["trill_depth"], 0, 0.1))
        out.append(note)
    return out


class SongbirdService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker):
        self.claude, self.spend = claude, spend

    def compose(self, description: str, model: str | None) -> dict[str, Any]:
        model = model or DEFAULT_MODEL
        messages: list[dict[str, Any]] = [{"role": "user", "content": description}]
        cost, tries = 0.0, []
        for attempt in (1, 2):
            try:
                response = self.claude.create(model=model, max_tokens=8000, system=SYSTEM, messages=messages,
                                              output_config={"format": {"type": "json_schema", "schema": SCHEMA}})
            except Exception as exc:
                raise to_api_error(exc) from exc
            cost += self.spend.charge(response, model) or 0.0
            raw = text_of(response)
            try:
                score = json.loads(raw)
            except ValueError:
                score = {"notes": []}
            found = problems(score)
            tries.append({"attempt": attempt, "problems": found})
            if not found:
                return {"title": score["title"], "explanation": score["explanation"], "notes": to_page(score),
                        "tries": tries, "cost_usd": round(cost, 6), "model": model}
            messages += [{"role": "assistant", "content": raw},
                         {"role": "user", "content": "The synth cannot play that yet:\n- " + "\n- ".join(found)
                          + "\nFix these and send the whole score again."}]
        raise ApiError(502, "unplayable", "The model's score still had problems after a second try: "
                                          + " ".join(tries[-1]["problems"][:3]))
