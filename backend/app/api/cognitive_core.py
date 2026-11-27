"""The cognitive core: a small model with tools against a big one, closed book and with the same tools, streamed as
NDJSON."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import Field

from ..schemas import ModelChoice
from ..services.cognitive_core import CognitiveCoreService
from .deps import cognitive_core, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


class CoreRun(ModelChoice):
    """`model` is the big model; the small one is LLM_LAB_CORE_MODEL."""
    questions: list[str] = Field(min_length=1, max_length=10)
    setups: list[str] = Field(min_length=1, max_length=6)
    budget_usd: float = Field(default=0.25, ge=0.02, le=1.0)  # for every setup and question of this run together


@router.get("/cognitive-core/info")
def info(service: CognitiveCoreService = Depends(cognitive_core)) -> dict[str, Any]:
    """The questions, the reference library, the tools, the prompts and the two models."""
    return service.info()


@router.post("/cognitive-core/run", dependencies=[Depends(require_budget)])
def run(body: CoreRun, service: CognitiveCoreService = Depends(cognitive_core)) -> StreamingResponse:
    """Each chosen question, one at a time, answered by every chosen setup side by side; each step streamed."""
    return StreamingResponse(service.run(body.questions, body.setups, body.model, body.budget_usd),
                             media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
