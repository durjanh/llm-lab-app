"""The English tutor: a speech token for the browser, and one streamed turn of the conversation."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..schemas import TutorTurnRequest
from ..services.tutor import TutorService
from .deps import require_budget, require_lab_page, tutor_service

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/tutor/config")
def tutor_config(service: TutorService = Depends(tutor_service)) -> dict[str, Any]:
    """Whether Azure Speech is set up, and the levels and scenarios to choose from."""
    return service.config()


@router.get("/tutor/speech-token")
def speech_token(fallback: bool = False, service: TutorService = Depends(tutor_service)) -> dict[str, Any]:
    """A 10-minute Azure Speech token, so the browser can speak and listen without the key.
    With fallback=true, a token for the fallback resource, used once the main one refuses."""
    return service.speech_token(fallback)


@router.post("/tutor/turn", dependencies=[Depends(require_budget)])
def tutor_turn(body: TutorTurnRequest, service: TutorService = Depends(tutor_service)) -> StreamingResponse:
    lines = service.turn(
        body.message, [line.model_dump() for line in body.history], subject=body.subject,
        subject_name=body.subject_name, level=body.level, stage=body.stage, style=body.style,
        native=body.native_language.strip(), scenario=body.scenario, spoken=body.spoken,
        pronunciation=body.pronunciation.model_dump() if body.pronunciation else None,
        images=[i.model_dump() for i in body.images], model=body.model, name=body.tutor_name, coaching=body.coaching,
        interview_brief=body.interview_brief)
    return StreamingResponse(lines, media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
