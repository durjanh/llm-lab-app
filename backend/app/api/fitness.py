"""The fitness coach page: the pose model and the form checks run in the browser; only the spoken reply is paid."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..schemas import ModelChoice
from ..services.fitness import FitnessService
from .deps import fitness, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


class Measure(BaseModel):
    label: str = Field(max_length=80)
    value: float
    unit: str = Field(default="", max_length=24)
    ideal: str = Field(default="", max_length=60)


class Check(BaseModel):
    label: str = Field(max_length=80)
    ok: bool
    detail: str = Field(default="", max_length=160)


class CoachRequest(ModelChoice):
    exercise: Literal["plank", "wall-sit", "lunge", "custom"]
    exercise_label: str = Field(default="", max_length=60)
    send: Literal["numbers", "photo", "both"] = "numbers"
    question: str = Field(default="", max_length=300)
    view: Literal["side", "front", "unknown"] = "unknown"
    in_position: bool = False
    hold_seconds: float | None = Field(default=None, ge=0, le=3600)
    target_seconds: float | None = Field(default=None, ge=0, le=3600)
    similarity: float | None = Field(default=None, ge=0, le=1)
    measures: list[Measure] = Field(default_factory=list, max_length=20)
    checks: list[Check] = Field(default_factory=list, max_length=20)
    photo: str = Field(default="", max_length=820_000)


@router.post("/fitness/coach", dependencies=[Depends(require_budget)])
def coach(body: CoachRequest, service: FitnessService = Depends(fitness)) -> dict[str, Any]:
    """A coach's spoken reply to "How's my form?", from the page's measurements, a photo, or both."""
    return service.coach(body.model_dump(exclude={"model"}), body.model)
