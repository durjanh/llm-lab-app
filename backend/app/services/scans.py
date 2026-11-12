"""The scan explainer: a person uploads a picture of a medical image (an X-ray, a CT or MRI slice, an ultrasound, a
skin photograph), and a model that reads images says what it can see, how sure it is, and what to ask the doctor.

It does not diagnose. A general model is not a radiologist: it has not been validated on scans, it misses findings and
it can describe things that are not there. So the model only fills in a fixed form, and code does the rest: it checks
the file, rejects wording that sounds like a diagnosis (one retry), writes the notices a person sees, and decides the
urgent message. Nothing uploaded is stored: the image goes to the chosen model and is then dropped.
"""
from __future__ import annotations

import base64
import json
import re
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import text_of
from .spend import SpendTracker

MAX_IMAGE_BYTES = 5 * 2**20
READ_MODEL = "claude-opus-5-5"  # the most capable model the lab offers: reading a scan is the hardest image job here

# The first bytes of each image type the models accept.
SIGNATURES = {"image/png": (b"\x89PNG",), "image/jpeg": (b"\xff\xd8\xff",), "image/webp": (b"RIFF",)}

NOTICE = ("This is an explanation from a general AI model, not a diagnosis. It has not been tested as a medical "
          "device. It can miss things and it can describe things that are not there. Decisions about your health "
          "belong with the doctor who has your scan, your history and can examine you.")
URGENT = ("The model flagged something it thinks should be looked at quickly. It may be wrong, but do not wait on it: "
          "contact your doctor or NHS 111 today and show them the scan. If you have severe symptoms now (sudden "
          "weakness, confusion, chest pain, trouble breathing, a severe headache), call 999.")
NOT_MEDICAL = "This does not look like a medical image, so there is nothing to explain. Upload a scan or a photograph taken for a doctor."

SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "required": ["is_medical_image", "modality", "body_region", "view", "quality", "quality_limits", "observations",
                 "looks_normal", "cannot_tell", "possibilities", "urgency", "urgency_reason", "questions", "summary", "answer"],
    "properties": {
        "is_medical_image": {"type": "boolean"},
        "modality": {"type": "string"},
        "body_region": {"type": "string"},
        "view": {"type": "string"},
        "quality": {"type": "string", "enum": ["good", "limited", "poor"]},
        "quality_limits": {"type": "string"},
        "observations": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["what", "where", "confidence", "plain"],
            "properties": {"what": {"type": "string"}, "where": {"type": "string"},
                           "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
                           "plain": {"type": "string"}}}},
        "looks_normal": {"type": "array", "items": {"type": "string"}},
        "cannot_tell": {"type": "array", "items": {"type": "string"}},
        "possibilities": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["name", "why", "also_consider"],
            "properties": {"name": {"type": "string"}, "why": {"type": "string"},
                           "also_consider": {"type": "string"}}}},
        "urgency": {"type": "string", "enum": ["routine", "soon", "urgent"]},
        "urgency_reason": {"type": "string"},
        "questions": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
        "answer": {"type": "string"},
    },
}

SYSTEM = """You help a patient understand a medical image they have been given, so they can have a better conversation
with their doctor. You see one picture of it (often a single slice or a photograph of a screen), not the full study.
Fill in the form as JSON.

- is_medical_image: false for anything that is not a medical image; then leave the lists empty.
- modality, body_region, view: what kind of image it is ("MRI, T2-weighted", "chest X-ray", "axial"). Say "unclear"
  rather than guess.
- quality and quality_limits: how much can be judged from this picture, and what limits it (one slice only, low
  resolution, a photograph of a screen, no contrast, no earlier scan to compare with).
- observations: what you can actually see that may matter, most important first. "what" in a radiologist's words,
  "where" as exactly as you can, "plain" in words a patient understands. "confidence" is how sure you are that the
  feature is really there and not an artefact or normal variation; use "high" rarely.
- looks_normal: structures that look as expected. Never write "normal scan": you have not seen the whole study.
- cannot_tell: what this picture cannot show, and what a radiologist would need to judge it.
- possibilities: what the observations could be consistent with, most likely first, each with why and what else would
  need ruling out. These are possibilities to discuss, never conclusions.
- urgency: "urgent" only for features that could need same-day attention (such as a possible bleed, a large mass with
  shift, a collapsed lung, a possible fracture of the spine); "soon" for things worth raising within days; otherwise
  "routine". Give the reason.
- questions: three to six good questions for the patient to ask their doctor about this image.
- summary: three or four plain sentences on what the picture shows and how far it can be trusted.
- answer: when the patient's note asks a question, a direct reply in two to four plain sentences, within the rules
  below; an empty string when the note asks nothing.

Rules for every field: describe, do not diagnose. Write "may", "could be consistent with", "appears". Never write
"you have", "this is", "diagnosis", "definitely", "confirms" or "rule out" as a conclusion. Never suggest a treatment,
a medicine or a dose. If the patient's note asks whether they have a condition, say what the picture shows and that
the doctor decides. Do not read out or repeat any name, date of birth or hospital number visible on the image."""

ASK_SYSTEM = """You are answering a patient's follow-up question about a medical image and the explanation they were
given (inside <reading>). Answer in plain words, in a short paragraph. Describe and explain; do not diagnose, and do
not suggest treatment, medicines or doses. Use "may" and "could". If the answer needs the full scan, an examination or
the patient's history, say so and suggest they ask their doctor. You are not a doctor."""

# Wording that states a conclusion. The model is told not to use it; code checks that it did not.
CONDITIONS = (r"cancer|tumou?r|stroke|alzheimer'?s(?: disease)?|dementia|fracture|pneumonia|multiple sclerosis|"
              r"aneurysm|bleed|haemorrhage|hemorrhage|infection|arthritis")
DEFINITE = re.compile(
    rf"\b(you (?:have|are suffering from|suffer from) (?:a |an |the |early |advanced |signs of )*(?:{CONDITIONS})|"
    rf"this is (?:a |an |early |advanced )*(?:{CONDITIONS})|the diagnosis is|is diagnostic of|without (?:a )?doubt|"
    r"this confirms|which confirms|you should (?:take|start|stop)|\d+\s?mg)\b", re.I)


def image_type(raw: bytes) -> str | None:
    """The media type, from the file's first bytes, or None when it is not a picture the models accept."""
    for media, starts in SIGNATURES.items():
        if raw.startswith(starts) and (media != "image/webp" or raw[8:12] == b"WEBP"):
            return media
    return None


def problems(reading: dict[str, Any]) -> list[str]:
    """Wording that sounds like a diagnosis or treatment advice, with where it was found."""
    if not reading.get("is_medical_image"):
        return []
    texts = [("summary", reading.get("summary", "")), ("urgency_reason", reading.get("urgency_reason", "")),
             ("answer", reading.get("answer", ""))]
    texts += [(f"observations[{i}]", f"{o.get('what', '')} {o.get('plain', '')}")
              for i, o in enumerate(reading.get("observations", []))]
    texts += [(f"possibilities[{i}]", f"{p.get('name', '')} {p.get('why', '')} {p.get('also_consider', '')}")
              for i, p in enumerate(reading.get("possibilities", []))]
    found = []
    for where, text in texts:
        match = DEFINITE.search(text)
        if match:
            found.append(f'{where} says "{match.group(0)}", which states a conclusion or advice')
    if not reading.get("questions"):
        found.append("questions is empty: give the patient questions to ask their doctor")
    if not reading.get("cannot_tell"):
        found.append("cannot_tell is empty: say what this one picture cannot show")
    return found


class ScanService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker):
        self.claude, self.spend = claude, spend

    def info(self) -> dict[str, Any]:
        return {"notice": NOTICE, "model": READ_MODEL, "max_mb": MAX_IMAGE_BYTES // 2**20,
                "accepts": list(SIGNATURES)}

    def _call(self, model: str, system: str, content: list[dict], schema: dict | None, max_tokens: int) -> tuple[str, float]:
        params: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "system": system,
                                  "messages": [{"role": "user", "content": content}]}
        if schema:
            params["output_config"] = {"format": {"type": "json_schema", "schema": schema}}
        try:
            response = self.claude.create(**params)
        except Exception as exc:
            raise to_api_error(exc) from exc
        return text_of(response), self.spend.charge(response, model) or 0.0

    def _image(self, image_b64: str) -> dict[str, Any]:
        try:
            raw = base64.b64decode(image_b64, validate=True)
        except ValueError:
            raise ApiError(400, "invalid_request", "The image must be base64.") from None
        media = image_type(raw)
        if media is None or len(raw) > MAX_IMAGE_BYTES:
            raise ApiError(400, "invalid_request", "Upload a PNG, JPEG or WebP picture under 5 MB. Export a DICOM "
                                                   "file as a picture first.")
        return {"type": "image", "source": {"type": "base64", "media_type": media, "data": image_b64}}

    def read(self, image_b64: str, note: str, model: str | None) -> dict[str, Any]:
        """The model's form for this image, checked. One retry, with the problems, if it sounds like a diagnosis."""
        model = model or READ_MODEL
        said = note.strip() or "No note."
        content = [self._image(image_b64), {"type": "text", "text": f"The patient's note: {said}"}]
        cost, tries = 0.0, []
        for attempt in range(2):
            text, spent = self._call(model, SYSTEM, content, SCHEMA, 6000)
            cost += spent
            try:
                reading = json.loads(text)
            except json.JSONDecodeError:
                reading, found = {}, ["the answer was not valid JSON matching the schema"]
            else:
                found = problems(reading)
            tries.append({"attempt": attempt + 1, "problems": found})
            if not found:
                break
            content = content + [{"type": "text", "text": "Your answer cannot be shown to a patient: "
                                  + "; ".join(found) + ". Answer again with the whole form, fixed."}]
        else:
            raise ApiError(502, "unsafe_wording", "The model's explanation kept stating conclusions, so it is not "
                                                  "shown. Try again, or choose another model.")
        medical = bool(reading.get("is_medical_image"))
        return {"reading": reading, "tries": tries, "cost_usd": round(cost, 6), "model": model, "notice": NOTICE,
                "message": None if medical else NOT_MEDICAL,
                "urgent_message": URGENT if medical and reading.get("urgency") == "urgent" else None}

    def ask(self, question: str, reading: dict, image_b64: str | None, model: str | None) -> dict[str, Any]:
        """A follow-up question about the image. The answer is dropped if it states a conclusion or advice."""
        model = model or READ_MODEL
        context = json.dumps(reading, ensure_ascii=False)[:8000]
        content: list[dict] = [self._image(image_b64)] if image_b64 else []
        content.append({"type": "text", "text": question})
        text, cost = self._call(model, f"{ASK_SYSTEM}\n\n<reading>{context}</reading>", content, None, 1200)
        if DEFINITE.search(text):
            text = ("The model's answer stated a conclusion or gave treatment advice, so it is not shown. That "
                    "question is one for your doctor.")
        return {"answer": text, "cost_usd": round(cost, 6), "model": model}
