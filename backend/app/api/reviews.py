"""The review dashboard: Azure Language in Foundry Tools reads multilingual product reviews, with Claude beside it."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import ReviewsAnalyze, ReviewsCompare
from ..services.reviews import ReviewsService
from .deps import require_budget, require_lab_page, reviews

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/reviews/info")
def info(service: ReviewsService = Depends(reviews)) -> dict[str, Any]:
    """The sample reviews, prices and limits, and any analyses already paid for this session."""
    return service.info()


@router.post("/reviews/analyze", dependencies=[Depends(require_budget)])
def analyze(body: ReviewsAnalyze, service: ReviewsService = Depends(reviews)) -> dict[str, Any]:
    return service.analyze(body.ids, body.text.strip() if body.text else None)


@router.post("/reviews/compare", dependencies=[Depends(require_budget)])
def compare(body: ReviewsCompare, service: ReviewsService = Depends(reviews)) -> dict[str, Any]:
    """Claude reads the same review, for comparison."""
    return service.compare(body.id, body.text.strip() if body.text else None, body.model)
