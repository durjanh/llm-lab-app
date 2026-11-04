"""Content Understanding and vision: documents, photos, audio and video, read by Foundry Tools and a multimodal model."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from ..schemas import UnderstandAnalyze, UnderstandVision
from ..services.understanding import UnderstandingService
from .deps import require_budget, require_lab_page, understanding

router = APIRouter(dependencies=[Depends(require_lab_page)])
media = APIRouter()  # <img>, <video> and <audio> cannot send the lab header; these files are already made, so free to read
PAID = [Depends(require_budget)]


@router.get("/understanding/info")
def info(service: UnderstandingService = Depends(understanding)) -> dict[str, Any]:
    return service.info()


@media.get("/understanding/media/{name}")
def sample(name: str, service: UnderstandingService = Depends(understanding)) -> Response:
    data, mime = service.media(name)
    return Response(data, media_type=mime, headers={"Cache-Control": "max-age=3600"})


@router.post("/understanding/prepare", dependencies=PAID)
def prepare(service: UnderstandingService = Depends(understanding)) -> dict[str, Any]:
    """Makes the photos (gpt-image-2), the video and the audio, if they are missing."""
    return service.prepare()


@router.post("/understanding/analyze", dependencies=PAID)
def analyze(body: UnderstandAnalyze, service: UnderstandingService = Depends(understanding)) -> dict[str, Any]:
    return service.analyze(body.sample, body.analyzer)


@router.post("/understanding/vision", dependencies=PAID)
def vision(body: UnderstandVision, service: UnderstandingService = Depends(understanding)) -> dict[str, Any]:
    return service.vision(body.images, body.task, body.question)
