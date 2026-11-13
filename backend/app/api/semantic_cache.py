"""The semantic cache page. Lookups and the pair comparison run on this machine and cost nothing; a miss calls a model,
so asking is guarded by the budget."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import Field

from ..schemas import ModelChoice
from ..services.semantic_cache import DEFAULT_THRESHOLD, DEFAULT_TTL_S, SemanticCacheService
from .deps import require_budget, require_lab_page, semantic_cache

router = APIRouter(dependencies=[Depends(require_lab_page)])


class CacheAsk(ModelChoice):
    question: str = Field(min_length=1, max_length=500)
    user: str = "everyone"
    threshold: float = Field(default=DEFAULT_THRESHOLD, ge=0.5, le=1.0)
    ttl_s: int = Field(default=DEFAULT_TTL_S, ge=1, le=30 * 24 * 3600)
    use_cache: bool = True
    check_numbers: bool = True  # code: the numbers in both questions must match
    check_model: bool = True  # a small model confirms the two questions have the same answer


@router.get("/semantic-cache/status")
def status(service: SemanticCacheService = Depends(semantic_cache)) -> dict[str, Any]:
    return service.status()


@router.post("/semantic-cache/pairs")
def pairs(service: SemanticCacheService = Depends(semantic_cache)) -> dict[str, Any]:
    """How similar each preset pair of questions is, by the local embedding model."""
    return service.pairs()


@router.post("/semantic-cache/ask", dependencies=[Depends(require_budget)])
def ask(body: CacheAsk, service: SemanticCacheService = Depends(semantic_cache)) -> dict[str, Any]:
    """The stored answer when a close enough question is cached for this scope, otherwise a model's (then cached)."""
    return service.ask(body.question.strip(), body.model, body.user, body.threshold, body.ttl_s, body.use_cache,
                       body.check_numbers, body.check_model)


@router.post("/semantic-cache/pairs/verify", dependencies=[Depends(require_budget)])
def verify_pairs(service: SemanticCacheService = Depends(semantic_cache)) -> dict[str, Any]:
    """The small model's check on every preset pair (seven tiny calls)."""
    return service.verify_pairs()


@router.post("/semantic-cache/clear")
def clear(service: SemanticCacheService = Depends(semantic_cache)) -> dict[str, Any]:
    return service.clear()
