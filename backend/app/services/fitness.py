"""The fitness coach page's spoken feedback. The page measures the pose itself (a pose model in the browser, then joint
angles and rule checks); this service turns those measurements into a sentence or two a coach would say. By default
the model gets only the numbers, never the camera picture, which is why the answer is quick, cheap and private. The
page can also send one photo, with or without the numbers, to show what changes when the model has to look for itself.
"""
from __future__ import annotations

import base64
import time
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, text_of
from .spend import SpendTracker

EXERCISES = {
    "plank": "a forearm or high plank, filmed from the side",
    "wall-sit": "a wall sit, filmed from the side",
    "lunge": "a static lunge stretch, filmed from the side",
    "custom": "a pose the person taught the page by holding it once",
}
MAX_PHOTO_BYTES = 600_000

SYSTEM = """You are a calm, encouraging fitness coach speaking aloud to someone who is holding an exercise right now.
They cannot read a screen, so your answer is spoken: one or two short sentences, at most 40 words, plain British
English, no lists, no markdown, no emoji.

Give the single most useful correction first, as something to do with the body ("lift your hips a little until your
shoulders, hips and ankles line up"), then a brief word of encouragement or the time left. If everything is within
range, say so and tell them what to keep doing. Answer their question if they asked one.

Ground every correction in what you were given. With measurements only, you cannot see them: never mention their
clothes, face, room or anything not in the numbers. With a photo, say only what you can actually see; if the photo is
unclear, say what to change so it can be seen. Never diagnose an injury. If they mention pain, dizziness or feeling
unwell, tell them to stop and rest, and nothing else."""


def describe(body: dict[str, Any]) -> str:
    """The measurements as the plain text the model reads: exactly what the page shows under "what the coach got"."""
    exercise = body["exercise"]
    lines = [f"Exercise: {body.get('exercise_label') or exercise} ({EXERCISES[exercise]})."]
    view = body.get("view") or "unknown"
    if view == "front":
        lines.append("Camera view: front-on, so angles along the body cannot be measured well.")
    elif view == "side":
        lines.append("Camera view: side-on.")
    if not body.get("in_position"):
        lines.append("They are not in the position yet.")
    held, target = body.get("hold_seconds"), body.get("target_seconds")
    if held is not None:
        lines.append(f"Held for {held:.0f} seconds" + (f" of a {target:.0f} second target." if target else "."))
    if body.get("similarity") is not None:
        lines.append(f"Similarity to the taught pose: {body['similarity']:.2f} (1 is a perfect match; 0.8 counts as "
                     "matching).")
    measures = body.get("measures") or []
    if measures:
        lines.append("Measurements:")
        for m in measures:
            unit = m.get("unit") or ""
            ideal = f" (aim for {m['ideal']})" if m.get("ideal") else ""
            lines.append(f"- {m['label']}: {m['value']:g}{unit}{ideal}")
    checks = body.get("checks") or []
    if checks:
        lines.append("Checks:")
        for c in checks:
            state = "OK" if c["ok"] else "NEEDS FIXING"
            detail = f": {c['detail']}" if c.get("detail") else ""
            lines.append(f"- {c['label']}: {state}{detail}")
    return "\n".join(lines)


class FitnessService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker):
        self.claude, self.spend = claude, spend

    def coach(self, body: dict[str, Any], model: str | None) -> dict[str, Any]:
        """One spoken reply, from the measurements, a photo, or both (the page's choice in `send`)."""
        model = model or DEFAULT_MODEL
        send = body.get("send") or "numbers"
        exercise = body["exercise"]
        question = (body.get("question") or "").strip() or "How's my form?"
        content: list[dict[str, Any]] = []
        if send in ("photo", "both"):
            content.append(self._photo(body.get("photo") or ""))
        if send in ("numbers", "both"):
            sent = describe(body)
        else:
            sent = (f"Exercise: {body.get('exercise_label') or exercise} ({EXERCISES[exercise]}). "
                    "You have one photo from their camera and no measurements.")
        sent += f"\n\nThey ask: \"{question}\""
        content.append({"type": "text", "text": sent})
        started = time.perf_counter()
        try:
            response = self.claude.create(model=model, max_tokens=200, system=SYSTEM,
                                          messages=[{"role": "user", "content": content}])
        except Exception as exc:
            raise to_api_error(exc) from exc
        cost = self.spend.charge(response, model) or 0.0
        reply = " ".join(text_of(response).split())
        if not reply:
            raise ApiError(502, "empty", "The model gave no answer. Try again.")
        usage = getattr(response, "usage", None)
        return {"reply": reply, "sent": sent, "photo_sent": send in ("photo", "both"), "model": model,
                "cost_usd": round(cost, 6), "seconds": round(time.perf_counter() - started, 2),
                "input_tokens": getattr(usage, "input_tokens", None)}

    @staticmethod
    def _photo(data_url: str) -> dict[str, Any]:
        """The camera frame as an image block, after checking it is a small JPEG."""
        prefix = "data:image/jpeg;base64,"
        data = data_url[len(prefix):] if data_url.startswith(prefix) else ""
        try:
            raw = base64.b64decode(data, validate=True)
        except ValueError:
            raw = b""
        if not raw.startswith(b"\xff\xd8") or len(raw) > MAX_PHOTO_BYTES:
            raise ApiError(400, "invalid_request", "Send the photo as a JPEG data URL under 600 KB.")
        return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}}
