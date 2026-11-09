"""The tutor: a conversation with Claude about any subject, spoken by a 3D avatar in the browser.

English is a speaking partner. Each message makes two Claude calls at once: one streams the
reply, which the page speaks sentence by sentence as it arrives; the other returns structured
feedback on what the learner said (corrections, vocabulary, a level estimate and a tip). Running
them side by side keeps the reply as fast as a single call.

Every other subject is a tutor who explains. One call answers in two parts separated by a line of
===: a few sentences the avatar says aloud, then a written, line-by-line explanation with LaTeX
for the maths. The learner can share pictures, such as homework or a screenshot, and the tutor
reads them. The conversation lives in the page; each message sends it back.
"""
from __future__ import annotations

import base64
import json
import re
import threading
from collections.abc import Iterator
from typing import Any

from ..core.errors import ApiError, describe
from ..gateways.azure_speech import SpeechNotAvailable, SpeechTokens
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, cost_usd, text_of
from .runs import Run, RunStreamer
from .spend import SpendTracker

LEVELS = {
    "auto": "not stated: judge it from how they write and speak, and adjust as you learn more",
    "A1": "A1, beginner: very short sentences, the most common words, present tense, speak slowly and simply",
    "A2": "A2, elementary: short simple sentences and everyday words, mostly present and past tense",
    "B1": "B1, intermediate: everyday topics in clear language, a few new words explained by context",
    "B2": "B2, upper intermediate: natural conversation, some idioms, ask for opinions and reasons",
    "C1": "C1, advanced: natural, nuanced English with idioms and phrasal verbs, challenge them to be precise",
    "C2": "C2, proficient: talk as with a native speaker, and push for style, register and subtle word choice",
}
SCENARIOS = {
    "chat": "Free conversation about whatever the learner wants to talk about.",
    "interview": "A job interview. You are a friendly interviewer for a job the learner chooses; ask one question at a time.",
    "restaurant": "At a restaurant. You are the waiter or waitress; the learner orders, asks questions and pays.",
    "travel": "Travelling: at the airport, the hotel and asking for directions. Play whoever the learner needs to talk to.",
    "ielts": "IELTS Speaking practice. Ask Part 1, then Part 2 and Part 3 style questions, one at a time, like an examiner.",
    "school": "Talking about school, homework, hobbies and friends, for younger learners.",
}
# Subjects other than English. Any other subject can be named by the learner.
SUBJECTS = {
    "maths": ("Maths", "Show every line of working. Name the rule or method used at each step. Check the answer "
                       "where you can, for example by substituting it back."),
    "physics": ("Physics", "Start from the physical idea, then the equation. Write the formula before substituting, "
                           "keep units on every quantity and check the answer's units and size make sense."),
    "chemistry": ("Chemistry", "Use correct formulas and balanced equations with state symbols. Show mole and "
                               "concentration calculations line by line with units, and link reactions to what is observed."),
    "biology": ("Biology", "Explain processes as a sequence of clear steps, use the correct terms and define them, "
                           "and connect structure to function."),
    "computing": ("Computer science", "Explain code line by line in short code blocks with the language named. Trace "
                                      "values through loops, and point out bugs and why they happen."),
    "history": ("History", "Give dates, causes and consequences in order, distinguish fact from interpretation, "
                           "and show how to use evidence in an answer."),
    "geography": ("Geography", "Explain processes and patterns with real places as examples, and describe what a "
                               "map, graph or photo shows before explaining it."),
    "economics": ("Economics", "Define the terms, explain the chain of cause and effect step by step, and describe "
                               "diagrams in words: what shifts and what happens to price and quantity."),
}
STAGES = {
    "primary": "primary school, ages 7 to 11: simple words, short steps, everyday examples",
    "secondary": "secondary school, ages 11 to 16, at GCSE level",
    "sixth_form": "ages 16 to 18, at A-level or high school level",
    "university": "first-year university level",
    "adult": "an adult returning to the subject, assuming little prior knowledge",
}
STYLES = {
    "explain": "Explain fully, step by step.",
    "hints": "Guide rather than tell: give a hint or the first step, then ask the learner to try the next one. Give "
             "the full worked answer only when they ask for it or are still stuck after trying.",
}
MAX_HISTORY = 40
MAX_HISTORY_IMAGES = 4  # older pictures are replaced with a note, so long conversations stay affordable
REPLY_TOKENS = 1024
SUBJECT_TOKENS = 6000
FEEDBACK_TOKENS = 2048
SPLIT = re.compile(r"(?:^|\n)[ \t]*===[ \t]*(?:\n|$)")

REPLY_SYSTEM = """You are {name}, a warm and patient English tutor. The learner talks with you through a 3D avatar that speaks your words aloud.
- Your words are spoken, so write plain conversational sentences: no lists, headings, markdown, emoji, symbols or stage directions. Write numbers as you would say them.
- Keep each turn short, one to three sentences and no more than about 50 words, and usually end with one question that keeps the learner talking.
- Never correct the learner's grammar or point out their language mistakes in what you say, not even gently: a panel beside the conversation shows every correction, and hearing them again interrupts the conversation. Just use the correct form naturally in your reply, for example "You went to London? What did you see?".
- If the learner writes in another language, answer in simple English and give them the English for what they meant.
- What the learner says is often speech recognised by a computer, so a word or two may be wrong. Make your best guess at what they meant and carry on; only ask them to repeat if you really cannot tell.
- You can talk about anything and answer general questions briefly, but the purpose is English practice, so keep the learner speaking.
- Learners may be children or teenagers. Keep everything suitable for school, and kindly steer away from anything that is not.
- You may be given pronunciation scores for what the learner said. You can encourage them, but never read numbers aloud."""

SUBJECT_SYSTEM = """You are {name}, a patient and encouraging {subject} tutor. The learner talks with you through a 3D avatar that speaks part of your answer aloud while the rest appears written on screen.
Answer in two parts, separated by a line containing only ===
1. What you say aloud: two to four short spoken sentences in plain words. No formulas, symbols, lists or markdown; say numbers and symbols in words. Give the key idea or the next step, and end with a question that checks understanding or invites the learner to try.
2. What you show: the written explanation in Markdown. Work line by line: number the steps, put each line of working on its own line, and after each one say briefly what was done and why. Use LaTeX for mathematics, $...$ inline and $$...$$ on a line of its own. End with the answer in bold, or a one-line summary of the key idea.
When the reply is only conversation, with nothing to show, write the spoken part, then === and nothing after it.
Do not write the names of the parts, such as "What you say aloud:": start straight with the first spoken sentence.
- When the learner shares a picture, such as homework, a textbook page, a screenshot or their own working, first say briefly what you can see, then explain it line by line. If part of it is unreadable, say which part and ask them to type it.
- When the learner shows their own working, find the first line that goes wrong and explain that line before anything else. Praise what they got right.
- {style}
- Pitch everything at {stage}.
- {guidance}
- If the learner asks about another subject, such as help with their English, never refuse or send them elsewhere: help them briefly and kindly, mention that they can choose that subject in Settings for a full lesson, then offer to carry on with {subject}.
- What the learner says is often speech recognised by a computer, so a word or two may be wrong. Make your best guess at what they meant and carry on; only ask them to repeat if you really cannot tell.
- Learners may be children or teenagers. Keep everything suitable for school, and kindly steer away from anything that is not. Help them learn: when something looks like a test they are taking right now, teach the method rather than handing over answers."""

FEEDBACK_SYSTEM = """You give written feedback to an English learner on their latest message to their tutor. Fill in the JSON:
- corrections: only real mistakes in grammar, word choice, word order or spelling that a good teacher would correct at this learner's level, at most three, the most important first. original is the learner's words; better is a natural corrected version of that sentence; why is one short sentence in simple English. Give each mistake once: when one corrected sentence fixes several mistakes, give only that sentence, not its parts again. When the message was spoken and transcribed, ignore punctuation, capital letters and spelling. Leave it empty when there is nothing worth correcting.
- vocabulary: up to three words or phrases that would help the learner say this more naturally or that fit the topic, each with a simple meaning and a short example. Leave it empty when nothing is useful.
- level: your estimate of the learner's CEFR level from the conversation so far, or "unknown" when there is too little to judge.
- tip: one short practical tip, about pronunciation when scores are given and some words scored low, otherwise about grammar or fluency. An empty string when there is none.
- praise: one short, specific piece of encouragement about something they did well.
- better_answer: when the learner was answering a question (an interview question, an exam question, or a question asking for their experience or opinion), how a confident speaker would answer it. Keep the learner's own ideas, facts and voice, but make it clearer, better organised and more complete, at a level a little above theirs; for interview answers, give the situation, what they did and the result. Two to five sentences, in the first person, as they would say it. An empty string for small talk, or when their answer was already strong.
- add: up to three short, specific things they could add to make the answer stronger, such as a number that shows the result, why they made a choice, or what they learned. Empty when there is nothing worth adding."""

COACHING = """Coaching is on. When the learner has just answered one of your questions, start your reply with brief spoken coaching before you move on: one short sentence on what was good about the answer, then one concrete way to make it stronger, either something they could add or a better way to say their main point, for example "I would put it like this: ...". Keep the coaching to two or three sentences, then ask your next question. This turn may be up to about 90 words. Grammar corrections still stay in the panel."""

FEEDBACK_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "required": ["corrections", "vocabulary", "level", "tip", "praise", "better_answer", "add"],
    "properties": {
        "corrections": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["original", "better", "why"],
            "properties": {"original": {"type": "string"}, "better": {"type": "string"}, "why": {"type": "string"}}}},
        "vocabulary": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["term", "meaning", "example"],
            "properties": {"term": {"type": "string"}, "meaning": {"type": "string"}, "example": {"type": "string"}}}},
        "level": {"type": "string", "enum": ["A1", "A2", "B1", "B2", "C1", "C2", "unknown"]},
        "tip": {"type": "string"},
        "praise": {"type": "string"},
        "better_answer": {"type": "string"},
        "add": {"type": "array", "items": {"type": "string"}},
    },
}


INTERVIEW_BRIEF = """The interview is for this role. Interview the learner as a real interviewer for it would: friendly but realistic, one question at a time, following up on what they say. Over the conversation, cover why they want the role and the company, their relevant experience, the technical depth the role needs (for a technical role, design questions about the company's own products), leadership and influence, behavioural examples (ask for situation, action and result), and finally invite their questions. Use only what the description says about the company; do not invent facts about it.
The role:
"""


def settings_text(level: str, native: str, scenario: str, brief: str = "") -> str:
    native_line = (f"The learner's first language is {native}. Use it only for a single word or short phrase when they "
                   "are stuck, and say that it is a translation." if native else "")
    brief_text = f"\n{INTERVIEW_BRIEF}{brief.strip()}" if scenario == "interview" and brief.strip() else ""
    return f"The learner's level: {LEVELS[level]}.\nScenario: {SCENARIOS[scenario]}\n{native_line}{brief_text}".strip()


def pronunciation_text(p: dict[str, Any] | None) -> str:
    """Azure's scores for the learner's speech, as a short note Claude can use."""
    if not p:
        return ""
    scores = ", ".join(f"{name} {round(p[name])}" for name in ("accuracy", "fluency", "prosody", "completeness")
                       if isinstance(p.get(name), (int, float)))
    weak = [f"{w['word']} ({round(w['accuracy'])})" for w in p.get("words", [])
            if isinstance(w.get("accuracy"), (int, float)) and w["accuracy"] < 70][:8]
    return (f"[Pronunciation scores out of 100 for this message: {scores or 'none'}."
            + (f" Words that scored low: {', '.join(weak)}." if weak else "") + "]")


class TutorService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, streamer: RunStreamer, speech: SpeechTokens):
        self.claude, self.spend, self.streamer, self.speech = claude, spend, streamer, speech

    def config(self) -> dict[str, Any]:
        return {"speech": self.speech.configured, "region": self.speech.region if self.speech.configured else None,
                "levels": list(LEVELS), "scenarios": SCENARIOS, "stages": STAGES,
                "subjects": {"english": "English", **{k: v[0] for k, v in SUBJECTS.items()}}}

    def speech_token(self, fallback: bool = False) -> dict[str, Any]:
        """A token for the main Speech resource, or for the fallback once the main one has refused."""
        try:
            return {"token": self.speech.token(fallback), "region": self.speech.region, "expires_in_s": 9 * 60,
                    "fallback": fallback, "has_fallback": self.speech.has_fallback}
        except SpeechNotAvailable as exc:
            raise ApiError(503, "speech_unavailable", str(exc)) from exc

    def turn(self, message: str, history: list[dict], *, subject: str = "english", subject_name: str = "",
             level: str = "auto", stage: str = "secondary", style: str = "explain", native: str = "",
             scenario: str = "chat", spoken: bool = False, pronunciation: dict | None = None,
             images: list[dict] | None = None, model: str | None = None, name: str = "Alex",
             coaching: bool = True, interview_brief: str = "") -> Iterator[str]:
        model = model or DEFAULT_MODEL
        tutor = name  # the person the learner talks to; `name` below is the subject's
        message = message.strip()
        if not message and not images:
            raise ApiError(400, "invalid_request", "Say or write something first, or share a picture.")
        if subject != "english" and subject != "other" and subject not in SUBJECTS:
            raise ApiError(400, "invalid_request", f"subject: choose one of english, {', '.join(SUBJECTS)} or other.")
        if subject == "other" and not subject_name.strip():
            raise ApiError(400, "invalid_request", "Name the subject you want to learn.")
        for image in images or []:
            check_image(image)
        history = history[-MAX_HISTORY:]
        while history and history[0]["role"] != "user":  # the API wants the conversation to start with the learner
            history = history[1:]
        note = pronunciation_text(pronunciation) if subject == "english" else ""
        learner = (message or "Please explain this.") + (f"\n\n{note}" if note else "")
        messages = [*conversation(history), {"role": "user", "content": content(learner, images or [])}]
        if subject != "english":
            name, guidance = SUBJECTS.get(subject, (subject_name.strip(), "Explain step by step, with examples."))
            system = SUBJECT_SYSTEM.format(name=tutor, subject=name, style=STYLES[style], stage=STAGES[stage],
                                           guidance=guidance)
            run = Run()
            return self.streamer.lines(run, lambda: self._explain(run, model, system, messages))
        system = [{"type": "text", "text": REPLY_SYSTEM.replace("{name}", tutor) + (f"\n{COACHING}" if coaching else "")},
                  {"type": "text", "text": settings_text(level, native, scenario, interview_brief)}]
        last_tutor = next((m["text"] for m in reversed(history) if m["role"] == "assistant"), "")
        run = Run()

        def work() -> None:
            costs = {"reply": 0.0, "feedback": 0.0}
            feedback = threading.Thread(target=self._feedback, daemon=True, args=(
                run, model, level, native, last_tutor, message, spoken, note, costs))
            feedback.start()
            try:
                params = {"model": model, "max_tokens": REPLY_TOKENS, "system": system, "messages": messages,
                          "output_config": {"effort": "low"},  # a quick, conversational reply
                          "cache_control": {"type": "ephemeral"}}
                with self.claude.stream(**params) as stream:
                    for event in stream:
                        if run.cancelled.is_set():
                            return
                        if event.type == "content_block_delta" and event.delta.type == "text_delta":
                            run.publish({"type": "text", "text": event.delta.text})
                    final = stream.get_final_message()
                self.spend.charge(final, model)
                costs["reply"] = cost_usd(final.usage, model) or 0.0
                run.publish({"type": "reply", "text": text_of(final).strip(), "stop_reason": final.stop_reason})
            finally:
                feedback.join(timeout=60)
                run.publish({"type": "done", "cost": round(sum(costs.values()), 5),
                             "spent_usd": round(self.spend.spent_usd, 4)})

        return self.streamer.lines(run, work)

    def _explain(self, run: Run, model: str, system: str, messages: list[dict]) -> None:
        """A subject tutor's answer: the spoken part streams as text events, the written part as written events."""
        split, cost = SaySplitter(), 0.0
        try:
            params = {"model": model, "max_tokens": SUBJECT_TOKENS, "system": system, "messages": messages,
                      "output_config": {"effort": "medium"},  # explanations, especially maths, need some thought
                      "cache_control": {"type": "ephemeral"}}  # caches the conversation, pictures included
            with self.claude.stream(**params) as stream:
                for event in stream:
                    if run.cancelled.is_set():
                        return
                    if event.type == "content_block_delta" and event.delta.type == "text_delta":
                        for kind, text in split.feed(event.delta.text):
                            run.publish({"type": kind, "text": text})
                final = stream.get_final_message()
            for kind, text in split.end():
                run.publish({"type": kind, "text": text})
            self.spend.charge(final, model)
            cost = cost_usd(final.usage, model) or 0.0
            run.publish({"type": "reply", "text": split.said.strip(), "written": split.shown.strip(),
                         "stop_reason": final.stop_reason})
        finally:
            run.publish({"type": "done", "cost": round(cost, 5), "spent_usd": round(self.spend.spent_usd, 4)})

    def _feedback(self, run: Run, model: str, level: str, native: str, last_tutor: str, message: str,
                  spoken: bool, note: str, costs: dict[str, float]) -> None:
        """Structured feedback on the learner's message. A failure here never stops the conversation."""
        context = (f"Learner's level setting: {level}. First language: {native or 'not given'}.\n"
                   f"The tutor had said: {last_tutor or '(this is the start of the conversation)'}\n"
                   f"The learner's message ({'spoken and transcribed' if spoken else 'typed'}): {message}\n{note}")
        try:
            response = self.claude.create(
                model=model, max_tokens=FEEDBACK_TOKENS, system=FEEDBACK_SYSTEM,
                messages=[{"role": "user", "content": context}],
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": FEEDBACK_SCHEMA}})
            self.spend.charge(response, model)
            costs["feedback"] = cost_usd(response.usage, model) or 0.0
            if run.cancelled.is_set():
                return
            run.publish({"type": "feedback", **json.loads(text_of(response))})
        except Exception as exc:  # the reply still arrives; the panel says why there is no feedback
            run.publish({"type": "feedback_error", "message": describe(exc)})


IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


def check_image(image: dict) -> None:
    if image.get("media_type") not in IMAGE_TYPES:
        raise ApiError(400, "invalid_request", "Pictures must be PNG, JPEG, WebP or GIF.")
    try:
        size = len(base64.b64decode(image["data"], validate=True))
    except (ValueError, KeyError) as exc:
        raise ApiError(400, "invalid_request", "A picture could not be read.") from exc
    if size > MAX_IMAGE_BYTES:
        raise ApiError(400, "invalid_request", f"A picture may be at most {MAX_IMAGE_BYTES // 2**20} MB.")


def content(text: str, images: list[dict]) -> str | list[dict]:
    """A learner's message: just text, or the pictures first and then the text, as Claude reads best."""
    if not images:
        return text
    return [*({"type": "image", "source": {"type": "base64", "media_type": i["media_type"], "data": i["data"]}}
              for i in images), {"type": "text", "text": text}]


def conversation(history: list[dict]) -> list[dict]:
    """The conversation for Claude. Only the newest MAX_HISTORY_IMAGES pictures are sent again."""
    budget = MAX_HISTORY_IMAGES
    out: list[dict] = []
    for line in reversed(history):
        images = line.get("images") or []
        kept = images[:budget] if line["role"] == "user" else []
        budget -= len(kept)
        text = line["text"] + (f"\n[{len(images) - len(kept)} earlier picture(s) not shown again]"
                               if len(kept) < len(images) else "")
        out.append({"role": line["role"], "content": content(text, kept)})
    return out[::-1]


class SaySplitter:
    """Splits a streamed answer at its === line into what the avatar says and what the page shows.

    Text before the line is held back a few characters at a time, so a === split across two
    chunks is never spoken. Without a === line, everything is spoken.
    """

    HOLD = 8

    def __init__(self) -> None:
        self.buffer, self.said, self.shown, self.showing = "", "", "", False

    def feed(self, text: str) -> list[tuple[str, str]]:
        if self.showing:
            self.shown += text
            return [("written", text)]
        self.buffer += text
        found = SPLIT.search(self.buffer)
        if found:
            say, rest = self.buffer[:found.start()], self.buffer[found.end():]
            self.buffer, self.showing = "", True
            out = [("text", say)] if say else []
            if rest:
                self.shown += rest
                out.append(("written", rest))
            self.said += say
            return out
        ready, self.buffer = self.buffer[:-self.HOLD], self.buffer[-self.HOLD:]
        self.said += ready
        return [("text", ready)] if ready else []

    def end(self) -> list[tuple[str, str]]:
        rest, self.buffer = self.buffer, ""
        if self.showing or not rest:
            return []
        if rest.strip() == "===":
            self.showing = True
            return []
        self.said += rest
        return [("text", rest)]
