"""The brain health check: start a check, read the drawn clock, score everything, and the summary as a PDF."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Response

from ..schemas import BrainClock, BrainFinish
from ..services.brain import BrainCheckService
from .deps import brain, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/brain/info")
def info(service: BrainCheckService = Depends(brain)) -> dict[str, Any]:
    return service.info()


@router.post("/brain/checks")
def start(service: BrainCheckService = Depends(brain)) -> dict[str, Any]:
    """A new check and its five words. Nothing is sent to a model yet."""
    return service.start()


@router.post("/brain/checks/{check_id}/clock", dependencies=[Depends(require_budget)])
def clock(check_id: str, body: BrainClock, service: BrainCheckService = Depends(brain)) -> dict[str, Any]:
    """The model says what the drawn clock shows; code scores it."""
    return service.clock(check_id, body.image, body.model)


@router.post("/brain/checks/{check_id}/finish", dependencies=[Depends(require_budget)])
def finish(check_id: str, body: BrainFinish, service: BrainCheckService = Depends(brain)) -> dict[str, Any]:
    return service.finish(check_id, body.model_dump())


@router.get("/brain/checks/{check_id}/pdf")
def pdf(check_id: str, service: BrainCheckService = Depends(brain)) -> Response:
    """The finished check as one page to take to a GP. Fetched by the page with the lab header."""
    return Response(service.pdf(check_id), media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="brain-health-check.pdf"'})


@router.get("/brain/history/{user}")
def history(user: str, service: BrainCheckService = Depends(brain)) -> dict[str, Any]:
    return {"history": service.history(user)}


@router.delete("/brain/history/{user}")
def forget(user: str, service: BrainCheckService = Depends(brain)) -> dict[str, Any]:
    return service.forget(user)
