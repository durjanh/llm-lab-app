"""The token counter: one prompt counted by many model families. Counting is free, so no route needs the budget."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import TokenCompareRequest, TokenCountRequest
from ..services.token_counter import TokenCounterService
from .deps import require_lab_page, token_counter

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/token-counter/models")
def models(service: TokenCounterService = Depends(token_counter)) -> list[dict[str, Any]]:
    """Every model family, by provider, with how it is counted and whether its tokenizer is downloaded yet."""
    return service.catalogue()


@router.post("/token-counter/count")
def count(body: TokenCountRequest, service: TokenCounterService = Depends(token_counter)) -> dict[str, Any]:
    """One model: the count, and the text cut into tokens where the tokenizer is published."""
    return service.count(body.model, body.system, body.prompt)


@router.post("/token-counter/compare")
def compare(body: TokenCompareRequest, service: TokenCounterService = Depends(token_counter)) -> list[dict[str, Any]]:
    """Every model at once. The first run downloads the open tokenizers to the backend (about 90 MB, once)."""
    return service.compare(body.system, body.prompt)
