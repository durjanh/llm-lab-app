"""ReAct and planning patterns: one task run by several agent patterns side by side, streamed as NDJSON."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import Field

from ..schemas import ModelChoice
from ..services.planning_patterns import PlanningPatternsService
from .deps import planning_patterns, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


class PatternRun(ModelChoice):
    task: str = Field(min_length=1, max_length=40)
    patterns: list[str] = Field(min_length=1, max_length=4)
    budget_usd: float = Field(default=0.25, ge=0.02, le=1.0)  # for all the patterns of this run together


@router.get("/planning-patterns/info")
def info(service: PlanningPatternsService = Depends(planning_patterns)) -> dict[str, Any]:
    """The tasks, the patterns, the tools and the invented shop they work on."""
    return service.info()


@router.post("/planning-patterns/run", dependencies=[Depends(require_budget)])
def run(body: PatternRun, service: PlanningPatternsService = Depends(planning_patterns)) -> StreamingResponse:
    """Each chosen pattern on the task, in parallel; every step streamed as it happens."""
    return StreamingResponse(service.run(body.task, body.patterns, body.model, body.budget_usd),
                             media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
