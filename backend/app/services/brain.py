"""The brain health check: a few short thinking tasks and a questionnaire about the risk factors a person can change,
repeated every few months so a change from the person's own baseline shows.

It is a screening demonstration, not a test for dementia. The model does two reading jobs: what a hand-drawn clock
shows, and which animals a person named. Code does everything else: it scores every task, compares with earlier
checks, and decides between three fixed outcomes. The wording a person sees is written here, not by the model.
The thresholds are illustrative and have not been validated against clinical diagnoses.
"""
from __future__ import annotations

import base64
import io
import json
import random
import re
import threading
import uuid
from collections import OrderedDict
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import CLAUDE_MODEL, text_of
from .spend import SpendTracker

MAX_CHECKS = 30
MAX_IMAGE_BYTES = 4 * 2**20
CLOCK_TIME = {"words": "ten past eleven", "hour": 11, "minute_at": 2}

# Five everyday words to remember. A different set each time, so the last check's words do not help.
WORD_SETS = [
    ["apple", "river", "chair", "garden", "candle"],
    ["window", "lemon", "bridge", "pillow", "train"],
    ["button", "forest", "kettle", "ladder", "orange"],
    ["mirror", "carrot", "harbour", "blanket", "violin"],
]

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december"]

NOTICE = ("This is not a medical test and cannot tell whether someone has dementia. Scores go up and down with "
          "tiredness, mood, schooling and first language. Only a doctor can assess memory problems.")

# The 14 risk factors in the 2024 Lancet Commission on dementia prevention, as questions where "yes" is the risk.
# "check_if_unsure" marks the ones a person may not know without a test.
RISKS: list[dict[str, Any]] = [
    {"id": "hearing", "factor": "Hearing loss", "question": "Do you struggle to hear, and not use a hearing aid?",
     "advice": "Book a hearing test (free on the NHS through your GP, and at many opticians). Using hearing aids "
               "when you need them is one of the changes with the strongest evidence."},
    {"id": "vision", "factor": "Untreated sight loss",
     "question": "Do you have a sight problem that has not been treated or corrected?",
     "advice": "Have an eye test. Glasses or cataract treatment keep the brain supplied with what it needs to see."},
    {"id": "blood_pressure", "factor": "High blood pressure", "check_if_unsure": True,
     "question": "Is your blood pressure high and not under control?",
     "advice": "Have your blood pressure measured (many pharmacies do it free) and follow the treatment you are given."},
    {"id": "cholesterol", "factor": "High LDL cholesterol", "check_if_unsure": True,
     "question": "Have you been told your cholesterol is high, and it is not being treated?",
     "advice": "Ask your GP surgery for a cholesterol check and what to do about the result."},
    {"id": "diabetes", "factor": "Diabetes", "check_if_unsure": True,
     "question": "Do you have diabetes that is not well controlled?",
     "advice": "Keep your diabetes reviews, and ask your GP for a test if you have never had one."},
    {"id": "obesity", "factor": "Obesity", "question": "Is your body mass index 30 or more?",
     "advice": "Losing even a little weight helps blood pressure and blood sugar. Your GP can refer you for support."},
    {"id": "smoking", "factor": "Smoking", "question": "Do you smoke?",
     "advice": "Stopping helps at any age. NHS stop smoking services are free and make success much more likely."},
    {"id": "alcohol", "factor": "Heavy drinking", "question": "Do you drink more than 14 units of alcohol a week?",
     "advice": "Keep to 14 units a week or fewer, spread over several days, with some days free of alcohol."},
    {"id": "inactivity", "factor": "Physical inactivity",
     "question": "Do you do less than 150 minutes of activity a week that makes you breathe faster?",
     "advice": "Build up to 150 minutes a week of brisk walking or similar. Any amount is better than none."},
    {"id": "isolation", "factor": "Social isolation",
     "question": "Do most weeks go by without seeing or talking to friends or family?",
     "advice": "Regular contact protects the brain: a club, a class, volunteering, or a weekly call all count."},
    {"id": "depression", "factor": "Depression",
     "question": "Have you felt low or lost interest in things for most of the past month, without getting help?",
     "advice": "Talk to your GP, or refer yourself to NHS talking therapies. Depression is treatable."},
    {"id": "head_injury", "factor": "Head injury", "question": "Have you had a serious head injury?",
     "advice": "Mention it to your GP if you have memory worries, and protect your head (helmets, fall-proofing)."},
    {"id": "mental_activity", "factor": "Little mental stimulation",
     "question": "Do you rarely do anything that stretches your mind (reading, learning, puzzles, music, a language)?",
     "advice": "Learning something new at any age builds reserve: a course, an instrument, a language."},
    {"id": "air_pollution", "factor": "Air pollution",
     "question": "Do you spend most days beside heavy traffic or in smoke?",
     "advice": "Where you can, walk on quieter streets and keep rooms ventilated when cooking or burning fuel."},
]

CLOCK_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "required": ["is_clock", "has_circle", "numbers_present", "numbers_placed_well", "hands", "hour_hand_at",
                 "minute_hand_at", "notes"],
    "properties": {
        "is_clock": {"type": "boolean"},
        "has_circle": {"type": "boolean"},
        "numbers_present": {"type": "array", "items": {"type": "integer"}},
        "numbers_placed_well": {"type": "boolean"},
        "hands": {"type": "integer"},
        "hour_hand_at": {"type": "integer"},
        "minute_hand_at": {"type": "integer"},
        "notes": {"type": "string"},
    },
}

CLOCK_SYSTEM = """You are shown a clock face that a person drew by hand on a dark board. Describe only what is drawn,
as JSON. Do not judge the person, guess the time they were asked for, or correct anything.
- is_clock: false when the drawing is not an attempt at a clock (then leave the rest empty or zero).
- has_circle: a closed, roughly round outline.
- numbers_present: every hour number you can read, 1 to 12, each once.
- numbers_placed_well: true only when the numbers go clockwise in order and are spread around the face about where a
  real clock has them (12 at the top, 3 on the right, 6 at the bottom, 9 on the left).
- hands: how many hands are drawn from the middle.
- hour_hand_at: the hour number the SHORTER hand points nearest to, or 0 when there is no such hand.
- minute_hand_at: the hour number the LONGER hand points nearest to (2 for ten past), or 0 when there is none.
- notes: one short sentence on anything unusual, such as numbers bunched on one side."""

ANIMALS_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["animals"],
    "properties": {"animals": {"type": "array", "items": {"type": "string"}}},
}

ANIMALS_SYSTEM = """A person was asked to name as many animals as they could in one minute. You are given what they
said or typed. List every animal they named, in their own words, each once (birds, fish and insects count; "dog" and
"dogs" are the same animal; "puppy" and "dog" are different). Do not add animals they did not say."""

OUTCOMES = {
    "fine": ("Nothing here stands out",
             "Your results today are in the range most adults score. Keep a check like this for comparison: what "
             "matters is whether your own results change over months."),
    "repeat": ("Worth repeating",
               "One part was lower than most adults score. That is common on a tired or distracted day. Try again in "
               "two or three weeks, rested and somewhere quiet. If it is low again, talk to your GP."),
    "gp": ("Worth talking to your GP",
           "More than one part was lower than most adults score, or lower than your own earlier results. This is not "
           "a diagnosis: tiredness, low mood, medicines, thyroid and vitamin problems all do this too, and several "
           "are easy to treat. Book a routine GP appointment and take this summary with you."),
    "concern": ("Talk to your GP about your memory",
                "You said that you, or someone close to you, have noticed your memory getting worse. That is the best "
                "reason to see a GP, whatever the scores here say. Take this summary with you."),
}


def safe_user(name: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", (name or "").lower()).strip("-")[:40] or "guest"


def _norm(word: str) -> str:
    w = re.sub(r"[^a-z]", "", word.lower())
    for plural, single in (("ies", "y"), ("ves", "f"), ("es", ""), ("s", "")):
        if w.endswith(plural) and len(w) > len(plural) + 2 and not w.endswith("ss"):
            trimmed = w[: -len(plural)] + single
            if plural != "es" or w[-3] in "sxzh":
                return trimmed
    return w


def score_recall(words: list[str], said: list[str]) -> dict[str, Any]:
    """One point for each of the words remembered, whatever the order."""
    heard = {_norm(w) for answer in said for w in re.split(r"[\s,;]+", answer) if w}
    got = [w for w in words if _norm(w) in heard]
    return {"score": len(got), "out_of": len(words), "remembered": got, "missed": [w for w in words if w not in got]}


def score_orientation(answer: dict[str, Any], today: date) -> dict[str, Any]:
    """One point each for the day of the week, the date (a day either side counts), the month and the year."""
    month = str(answer.get("month", "")).strip().lower()
    month_ok = month == MONTHS[today.month - 1] or month == str(today.month)
    try:
        day_ok = abs(int(answer.get("day", 0)) - today.day) <= 1
    except (TypeError, ValueError):
        day_ok = False
    try:
        year_ok = int(answer.get("year", 0)) == today.year
    except (TypeError, ValueError):
        year_ok = False
    right = {"weekday": str(answer.get("weekday", "")).strip().lower() == WEEKDAYS[today.weekday()],
             "day": day_ok, "month": month_ok, "year": year_ok}
    return {"score": sum(right.values()), "out_of": 4, "right": right}


def clock_problems(reading: dict[str, Any]) -> list[str]:
    """Why a clock reading cannot be scored, or nothing when it can."""
    found = []
    if any(not isinstance(n, int) or not 1 <= n <= 12 for n in reading.get("numbers_present", [])):
        found.append("numbers_present must hold only the hours 1 to 12")
    if not 0 <= reading.get("hands", 0) <= 6:
        found.append("hands must be between 0 and 6")
    for key in ("hour_hand_at", "minute_hand_at"):
        if not 0 <= reading.get(key, 0) <= 12:
            found.append(f"{key} must be an hour from 1 to 12, or 0 for none")
    return found


def score_clock(reading: dict[str, Any]) -> dict[str, Any]:
    """Five points: an outline, all twelve numbers, numbers in the right places, two hands, and the right time."""
    if not reading.get("is_clock"):
        return {"score": 0, "out_of": 5, "points": {}, "notes": "The drawing was not read as a clock."}
    points = {
        "A closed, round outline": bool(reading["has_circle"]),
        "All twelve numbers": set(reading["numbers_present"]) >= set(range(1, 13)),
        "Numbers in the right places": bool(reading["numbers_placed_well"]),
        "Two hands": reading["hands"] == 2,
        f"Hands show {CLOCK_TIME['words']}": (reading["hour_hand_at"] == CLOCK_TIME["hour"]
                                              and reading["minute_hand_at"] == CLOCK_TIME["minute_at"]),
    }
    return {"score": sum(points.values()), "out_of": 5, "points": points, "notes": reading.get("notes", "")}


def count_animals(named: list[str], transcript: str) -> list[str]:
    """The model's list, kept only where the person's own words contain it, each animal once."""
    said = {_norm(w) for w in re.split(r"[^A-Za-z]+", transcript) if w}
    kept: dict[str, str] = {}
    for animal in named:
        parts = [_norm(w) for w in animal.split() if _norm(w)]
        if parts and all(p in said for p in parts):
            kept.setdefault(" ".join(parts), animal.strip().lower())
    return list(kept.values())


def decide(scores: dict[str, Any], concern: bool, earlier: list[dict]) -> dict[str, Any]:
    """The outcome, from fixed rules. Low parts today, and any drop from the person's own earlier checks."""
    low = []
    if scores["recall"]["score"] <= 2:
        low.append("word recall")
    if scores["orientation"]["score"] <= 2:
        low.append("day and date")
    if scores["clock"] and scores["clock"]["score"] <= 3:
        low.append("clock drawing")
    if scores["fluency"]["count"] < 12:
        low.append("naming animals")
    drops = []
    if earlier:
        best = max(e["total"] for e in earlier)
        if best - scores["total"] >= 3:
            drops.append(f"your total is {best - scores['total']} points below your best earlier check ({best})")
        last = earlier[-1]
        if last["recall"] - scores["recall"]["score"] >= 2:
            drops.append(f"you remembered {last['recall'] - scores['recall']['score']} fewer words than last time")
    key = "concern" if concern else "gp" if len(low) >= 2 or drops else "repeat" if low else "fine"
    title, text = OUTCOMES[key]
    return {"key": key, "title": title, "text": text, "low": low, "drops": drops}


def risk_summary(answers: dict[str, str]) -> list[dict[str, str]]:
    """The risk factors that apply, each with what to do. 'Not sure' counts where only a test can tell."""
    found = []
    for r in RISKS:
        a = answers.get(r["id"], "no")
        if a == "yes":
            found.append({"factor": r["factor"], "advice": r["advice"], "why": "You said yes."})
        elif a == "unsure" and r.get("check_if_unsure"):
            found.append({"factor": r["factor"], "advice": r["advice"], "why": "You were not sure: worth a check."})
    return found


class BrainCheckService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, root: Path,
                 today: Callable[[], date] = date.today):
        self.claude, self.spend, self.root, self.today = claude, spend, root, today
        self.checks: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def info(self) -> dict[str, Any]:
        return {"risks": [{k: r[k] for k in ("id", "factor", "question")} for r in RISKS], "notice": NOTICE,
                "clock_time": CLOCK_TIME["words"], "model": CLAUDE_MODEL}

    def start(self) -> dict[str, Any]:
        """A new check, with its five words. Nothing is sent to a model yet."""
        check_id = uuid.uuid4().hex
        with self._lock:
            self.checks[check_id] = {"words": random.choice(WORD_SETS), "clock": None, "result": None}
            while len(self.checks) > MAX_CHECKS:
                self.checks.popitem(last=False)
        return {"check_id": check_id, "words": self.checks[check_id]["words"]}

    def _check(self, check_id: str) -> dict[str, Any]:
        found = self.checks.get(check_id)
        if found is None:
            raise ApiError(404, "not_found", "That check has ended. Start a new one.")
        return found

    def _call(self, model: str, system: str, content: list[dict], schema: dict) -> tuple[dict, float]:
        try:
            response = self.claude.create(model=model, max_tokens=1500, system=system,
                                          messages=[{"role": "user", "content": content}],
                                          output_config={"format": {"type": "json_schema", "schema": schema}})
        except Exception as exc:
            raise to_api_error(exc) from exc
        cost = self.spend.charge(response, model) or 0.0
        try:
            return json.loads(text_of(response)), cost
        except json.JSONDecodeError:
            raise ApiError(502, "unreadable", "The model's answer was not the JSON asked for. Try again.") from None

    def clock(self, check_id: str, image_b64: str, model: str | None) -> dict[str, Any]:
        """The model says what the drawn clock shows; code scores it."""
        check = self._check(check_id)
        model = model or CLAUDE_MODEL
        try:
            raw = base64.b64decode(image_b64, validate=True)
        except ValueError:
            raise ApiError(400, "invalid_request", "The image must be a base64 PNG.") from None
        if not raw.startswith(b"\x89PNG") or len(raw) > MAX_IMAGE_BYTES:
            raise ApiError(400, "invalid_request", "Send the drawing as a PNG under 4 MB.")
        content = [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image_b64}},
                   {"type": "text", "text": "Describe this drawing."}]
        reading, cost = self._call(model, CLOCK_SYSTEM, content, CLOCK_SCHEMA)
        problems = clock_problems(reading)
        if problems:
            raise ApiError(502, "unreadable", "The clock could not be read: " + "; ".join(problems))
        check["clock"] = {**score_clock(reading), "reading": reading}
        return {"clock": check["clock"], "cost_usd": round(cost, 6), "model": model}

    def finish(self, check_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Scores everything, compares with earlier checks, decides the outcome, and saves it if the person agreed."""
        check = self._check(check_id)
        model = body.get("model") or CLAUDE_MODEL
        today = self.today()
        try:
            theirs = date.fromisoformat(body.get("today") or "")
        except ValueError:
            theirs = today
        if abs((theirs - today).days) <= 1:  # the person's own calendar day, near midnight or abroad
            today = theirs
        transcript = (body.get("fluency_text") or "").strip()[:4000]
        cost, named = 0.0, []
        if transcript:
            answer, cost = self._call(model, ANIMALS_SYSTEM, [{"type": "text", "text": transcript}], ANIMALS_SCHEMA)
            named = [a for a in answer.get("animals", []) if isinstance(a, str)]
        animals = count_animals(named, transcript)
        scores: dict[str, Any] = {
            "recall": score_recall(check["words"], body.get("recall") or []),
            "orientation": score_orientation(body.get("orientation") or {}, today),
            "clock": check["clock"],
            "fluency": {"count": len(animals), "animals": animals},
        }
        scores["total"] = (scores["recall"]["score"] + scores["orientation"]["score"]
                           + (check["clock"]["score"] if check["clock"] else 0))
        scores["total_out_of"] = 14
        user = safe_user(body.get("user") or "")
        earlier = self.history(user)
        outcome = decide(scores, bool(body.get("concern")), earlier)
        result = {"date": today.isoformat(), "user": user, "scores": scores, "outcome": outcome,
                  "risks": risk_summary(body.get("risks") or {}), "earlier": earlier, "notice": NOTICE,
                  "next_check": (today + timedelta(days=90)).isoformat(), "saved": bool(body.get("save")),
                  "cost_usd": round(cost, 6), "model": model}
        if body.get("save"):
            entry = {"date": result["date"], "total": scores["total"], "recall": scores["recall"]["score"],
                     "orientation": scores["orientation"]["score"],
                     "clock": check["clock"]["score"] if check["clock"] else None,
                     "animals": len(animals), "outcome": outcome["key"]}
            self.root.mkdir(parents=True, exist_ok=True)
            (self.root / f"{user}.json").write_text(json.dumps(earlier + [entry], indent=1))
        check["result"] = result
        return result

    def history(self, user: str) -> list[dict[str, Any]]:
        path = self.root / f"{safe_user(user)}.json"
        try:
            return json.loads(path.read_text()) if path.exists() else []
        except (OSError, json.JSONDecodeError):
            return []

    def forget(self, user: str) -> dict[str, Any]:
        """Deletes every saved check for this person."""
        (self.root / f"{safe_user(user)}.json").unlink(missing_ok=True)
        return {"history": []}

    def pdf(self, check_id: str) -> bytes:
        """The finished check as one printable page to take to a GP."""
        result = self._check(check_id)["result"]
        if not result:
            raise ApiError(409, "not_finished", "Finish the check first.")
        return summary_pdf(result)


def summary_pdf(result: dict[str, Any]) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    styles = getSampleStyleSheet()
    body, small = styles["BodyText"], styles["BodyText"].clone("small", fontSize=8, leading=10)
    s, o = result["scores"], result["outcome"]
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm,
                            bottomMargin=16 * mm, title="Brain health check summary")
    grid = TableStyle([("GRID", (0, 0), (-1, -1), 0.4, colors.grey), ("BACKGROUND", (0, 0), (-1, 0), colors.whitesmoke),
                       ("FONTSIZE", (0, 0), (-1, -1), 9), ("VALIGN", (0, 0), (-1, -1), "TOP")])
    clock = f"{s['clock']['score']} of 5" if s["clock"] else "Not done"
    rows = [["Part", "Result", "What it looks at"],
            ["Word recall", f"{s['recall']['score']} of {s['recall']['out_of']}", "Remembering five words after a few minutes"],
            ["Day and date", f"{s['orientation']['score']} of 4", "Knowing the day, date, month and year"],
            ["Clock drawing", clock, "Planning and laying out a clock face"],
            ["Naming animals", f"{s['fluency']['count']} in one minute", "Finding words quickly"]]
    story: list[Any] = [
        Paragraph("Brain health check summary", styles["Title"]),
        Paragraph(f"{result['user'].title()} · {result['date']}", body),
        Paragraph(result["notice"], small), Spacer(1, 4 * mm),
        Table(rows, colWidths=[38 * mm, 38 * mm, 98 * mm], style=grid), Spacer(1, 4 * mm),
        Paragraph(f"<b>{o['title']}</b>", body), Paragraph(o["text"], body)]
    for line in o["low"] and ["Lower than most adults score: " + ", ".join(o["low"]) + "."] or []:
        story.append(Paragraph(line, body))
    for drop in o["drops"]:
        story.append(Paragraph(f"Compared with earlier checks: {drop}.", body))
    if result["earlier"]:
        story += [Spacer(1, 4 * mm), Paragraph("<b>Earlier checks</b>", body),
                  Table([["Date", "Total of 14", "Words", "Animals"]]
                        + [[e["date"], e["total"], e["recall"], e["animals"]] for e in result["earlier"][-8:]],
                        colWidths=[40 * mm, 30 * mm, 30 * mm, 30 * mm], style=grid)]
    if result["risks"]:
        story += [Spacer(1, 4 * mm), Paragraph("<b>Things you can change</b>", body)]
        story += [Paragraph(f"<b>{r['factor']}.</b> {r['advice']}", body) for r in result["risks"]]
    story += [Spacer(1, 4 * mm),
              Paragraph("Made by a demonstration tool. The thresholds are illustrative and have not been validated "
                        "against clinical diagnoses. The risk factors are those in the 2024 Lancet Commission on "
                        "dementia prevention, intervention and care.", small)]
    doc.build(story)
    return buf.getvalue()
