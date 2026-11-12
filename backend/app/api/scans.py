"""The scan explainer: what a model can see in a medical image, checked by code, and follow-up questions."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import ScanAsk, ScanRead
from ..services.scans import ScanService
from .deps import require_budget, require_lab_page, scans

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/scans/info")
def info(service: ScanService = Depends(scans)) -> dict[str, Any]:
    return service.info()


@router.post("/scans/read", dependencies=[Depends(require_budget)])
def read(body: ScanRead, service: ScanService = Depends(scans)) -> dict[str, Any]:
    """What the image shows, as a checked form. The image is not stored."""
    return service.read(body.image, body.note, body.model)


@router.post("/scans/ask", dependencies=[Depends(require_budget)])
def ask(body: ScanAsk, service: ScanService = Depends(scans)) -> dict[str, Any]:
    return service.ask(body.question.strip(), body.reading, body.image, body.model)
