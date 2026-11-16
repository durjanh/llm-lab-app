"""The prosody planner: how a reply should sound, chosen from the conversation, then written as SSML for an Azure
neural voice (or as a speaking speed for the local one).

A plan has a style tag (the delivery), and numbers that follow from it: speaking rate, pitch, the pause after a
sentence and, where the voice supports it, an Azure speaking style with a strength. Two things choose the tag:

  * rules in code that read the caller's words (upset, worried, pleased, a quick factual question), and
  * the model, which starts its reply with a tag such as [calm] in the same call that writes the text.

Rules win when the caller is upset or worried, because a cheerful reply to an angry caller is the worse mistake.
The last tag is kept for the conversation, so calm carries into the next turn instead of snapping back at once.
The expressiveness setting (0 off, 3 strong) scales every number; 0 gives the plain voice.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from xml.sax.saxutils import escape

TAGS = ("neutral", "calm", "empathetic", "cheerful", "brisk", "serious")
MAX_EXPRESSIVENESS = 3
# What each tag means in numbers at expressiveness 2 (rate and pitch are percentages), and the Azure speaking
# styles that fit it, best first. A voice that has none of them is given the numbers alone.
BASE = {
    "neutral": {"rate": 0, "pitch": 0, "pause": 200, "styles": []},
    "calm": {"rate": -10, "pitch": -3, "pause": 380, "styles": ["calm", "gentle", "empathetic", "friendly"]},
    "empathetic": {"rate": -8, "pitch": -2, "pause": 340, "styles": ["empathetic", "gentle", "sad"]},
    "cheerful": {"rate": 4, "pitch": 3, "pause": 160, "styles": ["cheerful", "friendly", "excited"]},
    "brisk": {"rate": 12, "pitch": 0, "pause": 90, "styles": ["chat"]},
    "serious": {"rate": -4, "pitch": -2, "pause": 300, "styles": ["serious", "customerservice"]},
}
# Styles each voice offers through mstts:express-as. From Microsoft's published voice list at the time of writing:
# a voice's styles can change by region and over time, so the page shows what was used and a missing one falls back.
VOICE_STYLES: dict[str, list[str]] = {
    "en-GB-SoniaNeural": ["cheerful", "sad"],
    "en-GB-RyanNeural": ["cheerful", "chat"],
    "en-US-JennyNeural": ["assistant", "chat", "customerservice", "newscast", "angry", "cheerful", "sad", "excited",
                          "friendly", "hopeful", "shouting", "terrified", "unfriendly", "whispering"],
    "en-US-AriaNeural": ["chat", "customerservice", "narration-professional", "newscast-casual", "newscast-formal",
                         "cheerful", "empathetic", "angry", "sad", "excited", "friendly", "terrified", "shouting",
                         "unfriendly", "whispering", "hopeful"],
    "en-US-GuyNeural": ["newscast", "angry", "cheerful", "sad", "excited", "friendly", "terrified", "shouting",
                        "unfriendly", "whispering", "hopeful"],
}
LOCAL_VOICES = {"bf_emma": "Emma (British)", "bf_isabella": "Isabella (British)", "bm_george": "George (British)",
                "bm_lewis": "Lewis (British)", "af_heart": "Heart (American)", "am_michael": "Michael (American)"}
DEGREE = {0: 0.0, 1: 0.6, 2: 1.0, 3: 1.6}  # styledegree by expressiveness
SCALE = {0: 0.0, 1: 0.5, 2: 1.0, 3: 1.5}  # how much of the rate, pitch and pause change is used
RATE_LIMITS, PITCH_LIMITS, PAUSE_LIMITS = (-30, 25), (-10, 10), (0, 1000)


@dataclass(frozen=True)
class Plan:
    tag: str
    rate: int  # percent change in speaking rate
    pitch: int  # percent change in pitch
    pause_ms: int  # after each sentence
    style: str | None  # an Azure express-as style, or None
    degree: float  # the style's strength
    source: str  # "model", "rules", "merged" or "carried"
    reason: str

    def as_dict(self) -> dict:
        return asdict(self)


class PlanError(ValueError):
    """A plan that is not allowed: an unknown tag or a number out of range."""


def validate(raw: object) -> dict:
    """A plan someone else proposed (the model, or a request), checked: known tag, numbers in range. Raises PlanError."""
    if not isinstance(raw, dict):
        raise PlanError("A plan must be an object.")
    tag = raw.get("tag")
    if tag not in TAGS:
        raise PlanError(f"Unknown style tag {tag!r}. Use one of: {', '.join(TAGS)}.")
    out = {"tag": tag}
    for key, (low, high) in (("rate", RATE_LIMITS), ("pitch", PITCH_LIMITS), ("pause_ms", PAUSE_LIMITS)):
        if key in raw:
            value = raw[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
                raise PlanError(f"{key} must be a number from {low} to {high}.")
            out[key] = int(round(value))
    return out


UPSET = re.compile(r"\b(angry|furious|ridiculous|terrible|awful|unacceptable|disgusting|useless|fed up|sick of|appalling|"
                   r"complain|complaint|not happy|third time|again and again|waste of|rubbish|outrageous|damn|bloody|"
                   r"hate|shocking)\b", re.I)
WORRIED = re.compile(r"\b(worried|scared|afraid|anxious|stolen|fraud|scam|lost my|died|passed away|hospital|"
                     r"emergency|panic|urgent|help me)\b", re.I)
PLEASED = re.compile(r"\b(thanks|thank you|great|brilliant|lovely|perfect|wonderful|amazing|cheers|love it|fantastic)\b", re.I)
QUICK = re.compile(r"^(what|when|where|which|who|how (much|many|long|far|old)|is|are|do|does|can|will)\b", re.I)


def rule_tag(user_text: str) -> tuple[str, str]:
    """The tag the caller's words call for, with the reason. "neutral" when nothing stands out."""
    text = user_text.strip()
    letters = [c for c in text if c.isalpha()]
    shouting = len(letters) >= 8 and sum(c.isupper() for c in letters) / len(letters) > 0.7
    if UPSET.search(text) or shouting or text.count("!") >= 3:
        return "calm", "The caller sounds upset: slower and lower, with longer pauses."
    if WORRIED.search(text):
        return "empathetic", "The caller sounds worried: warm and unhurried."
    if PLEASED.search(text):
        return "cheerful", "The caller is pleased: a little brighter."
    # A short question: starts with a question word or ends with "?". A number alone ("my card number is 4111") is
    # someone giving details, not asking, so it does not make the reply brisk.
    if len(text.split()) <= 9 and (QUICK.match(text) or text.rstrip().endswith("?")):
        return "brisk", "A short factual question: a quick, direct answer."
    return "neutral", "Nothing in the caller's words calls for a different delivery."


class Mood:
    """The delivery carried across one conversation's turns."""

    def __init__(self) -> None:
        self.tag = "neutral"
        self.calm_turns = 0  # turns left in which a bright or brisk tag is softened

    def choose(self, user_text: str, model_tag: str | None) -> tuple[str, str, str]:
        """(tag, source, reason) for the next reply."""
        rule, why = rule_tag(user_text)
        model = model_tag if model_tag in TAGS else None
        careful = {"calm", "empathetic"}
        if rule in careful:
            tag = model if model in careful else rule
            source, reason = ("merged" if model == rule else "rules"), why
            self.calm_turns = 2
        elif model:
            tag, source, reason = model, "model", "The model chose this delivery from the conversation."
            if self.calm_turns and tag in {"cheerful", "brisk"}:
                tag, source, reason = "calm", "carried", "Still easing off after an upset turn, so not brighter yet."
        elif rule != "neutral":
            tag, source, reason = rule, "rules", why
        elif self.calm_turns:
            tag, source, reason = "calm", "carried", "Kept calm from the last turn."
        else:
            tag, source, reason = "neutral", "rules", why
        if rule not in careful and self.calm_turns:
            self.calm_turns -= 1
        self.tag = tag
        return tag, source, reason


def build_plan(tag: str, voice: str, expressiveness: int, source: str = "rules", reason: str = "",
               overrides: dict | None = None) -> Plan:
    """The numbers for a tag at an expressiveness level, for a voice. Off (0) is the plain voice."""
    if tag not in TAGS:
        raise PlanError(f"Unknown style tag {tag!r}.")
    level = min(MAX_EXPRESSIVENESS, max(0, int(expressiveness)))
    base = BASE[tag]
    scale = SCALE[level]
    rate = base["rate"] * scale if overrides is None or "rate" not in overrides else overrides["rate"] * scale
    pitch = base["pitch"] * scale if overrides is None or "pitch" not in overrides else overrides["pitch"] * scale
    plain = 200  # the pause of the plain voice
    pause = plain + (base["pause"] - plain) * scale
    offered = VOICE_STYLES.get(voice, [])
    style = next((s for s in base["styles"] if s in offered), None) if level else None
    if tag == "brisk" and style == "chat" and level < 2:
        style = None
    degree = DEGREE[level] if style else 0.0
    clamp = lambda v, lim: int(max(lim[0], min(lim[1], round(v))))  # noqa: E731
    return Plan(tag, clamp(rate, RATE_LIMITS), clamp(pitch, PITCH_LIMITS), clamp(pause, PAUSE_LIMITS), style,
                round(min(2.0, degree), 1), source, reason or ("Expressiveness is off: the plain voice." if not level else ""))


def parse_tag(head: str) -> tuple[str | None, str, bool]:
    """Reads the [tag] at the start of a reply. Returns (tag or None, the text after it, whether it is decided).
    Undecided means more text is needed: the reply so far could still become a tag."""
    stripped = head.lstrip()
    if not stripped:
        return None, "", False
    if not stripped.startswith("["):
        return None, head, True
    end = stripped.find("]")
    if end == -1:
        return (None, head, True) if len(stripped) > 16 else (None, "", False)
    tag = stripped[1:end].strip().lower()
    return (tag if tag in TAGS else None), stripped[end + 1:].lstrip(), True


def locale_of(voice: str) -> str:
    return "-".join(voice.split("-")[:2]) or "en-GB"


def build_ssml(text: str, voice: str, plan: Plan, last: bool = False) -> str:
    """SSML for one piece. The text is escaped; breaks and prosody come from the plan. Only voices with the style get
    an express-as wrapper."""
    body = escape(text)
    if plan.pause_ms and not last:
        body += f'<break time="{plan.pause_ms}ms"/>'
    if plan.rate or plan.pitch:
        body = f'<prosody rate="{plan.rate:+d}%" pitch="{plan.pitch:+d}%">{body}</prosody>'
    if plan.style:
        body = f'<mstts:express-as style="{plan.style}" styledegree="{plan.degree}">{body}</mstts:express-as>'
    return ('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" '
            f'xml:lang="{locale_of(voice)}"><voice name="{escape(voice)}">{body}</voice></speak>')


def local_speed(plan: Plan) -> float:
    """The local voice has no SSML: only a speed, from the plan's rate."""
    return round(min(1.5, max(0.7, 1 + plan.rate / 100)), 2)
