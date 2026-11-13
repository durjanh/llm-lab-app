"""The delivery page: the pages' text is static; only turning a brief into a design is a paid call."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import Field

from ..schemas import ModelChoice
from ..services.delivery import DeliveryService
from .deps import delivery, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


class BriefDesign(ModelChoice):
    brief: str = Field(min_length=20, max_length=4000)


@router.post("/delivery/design", dependencies=[Depends(require_budget)])
def design(body: BriefDesign, service: DeliveryService = Depends(delivery)) -> dict[str, Any]:
    """A first-pass solution design for a business brief, written by a model and checked by code."""
    return service.design(body.brief.strip(), body.model)
