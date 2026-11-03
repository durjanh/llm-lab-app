from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..services.status import StatusService
from .deps import status_service

router = APIRouter()


@router.get("/status")
def status(service: StatusService = Depends(status_service)) -> dict[str, Any]:
    return service.report()


@router.get("/sample/handbook")
def handbook() -> dict[str, str]:
    return {"text": StatusService.handbook()}
