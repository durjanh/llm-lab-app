"""The review-passes lab: code reviews run in different ways against one invented change set, scored against a key."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import ModelChoice
from ..services.review_passes import ReviewPassesService
from .deps import require_budget, require_lab_page, review_passes

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/review-passes/info")
def info(service: ReviewPassesService = Depends(review_passes)) -> dict[str, Any]:
    """The change set, the answer key, the prompts and the findings schema. Free."""
    return service.info()


@router.post("/review-passes/criteria", dependencies=[Depends(require_budget)])
def criteria(body: ModelChoice, service: ReviewPassesService = Depends(review_passes)) -> dict[str, Any]:
    """Vague criteria against explicit ones: two reviews, scored."""
    return service.criteria(body.model)


@router.post("/review-passes/passes", dependencies=[Depends(require_budget)])
def passes(body: ModelChoice, service: ReviewPassesService = Depends(review_passes)) -> dict[str, Any]:
    """One pass over everything against per-file passes plus an integration pass."""
    return service.passes(body.model)


@router.post("/review-passes/independent", dependencies=[Depends(require_budget)])
def independent(body: ModelChoice, service: ReviewPassesService = Depends(review_passes)) -> dict[str, Any]:
    """A self-review in the conversation that explained the change against a reviewer with no history."""
    return service.independent(body.model)


@router.post("/review-passes/confidence", dependencies=[Depends(require_budget)])
def confidence(body: ModelChoice, service: ReviewPassesService = Depends(review_passes)) -> dict[str, Any]:
    """Findings with a confidence and a detected pattern, routed by confidence."""
    return service.confidence(body.model)


@router.post("/review-passes/ci", dependencies=[Depends(require_budget)])
def ci(body: ModelChoice, service: ReviewPassesService = Depends(review_passes)) -> dict[str, Any]:
    """A first review, then a re-run on a fixed file that reports only new and still-open findings."""
    return service.ci(body.model)
