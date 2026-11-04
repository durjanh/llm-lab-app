"""Search pipeline: ingest every modality into Azure AI Search, enrich it, query it four ways, measure relevance."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import SearchAsk, SearchQuery
from ..services.searchlab import SearchLabService
from .deps import require_budget, require_lab_page, searchlab

router = APIRouter(dependencies=[Depends(require_lab_page)])
PAID = [Depends(require_budget)]


@router.get("/searchlab/info")
def info(service: SearchLabService = Depends(searchlab)) -> dict[str, Any]:
    return service.info()


@router.post("/searchlab/ingest", dependencies=PAID)
def ingest(service: SearchLabService = Depends(searchlab)) -> dict[str, Any]:
    """Extract, chunk, enrich, embed and index, step by step. Rebuilds the lab's index."""
    return service.ingest()


@router.post("/searchlab/query", dependencies=PAID)
def query(body: SearchQuery, service: SearchLabService = Depends(searchlab)) -> dict[str, Any]:
    return service.query(body.text, body.mode)


@router.post("/searchlab/evaluate", dependencies=PAID)
def evaluate(service: SearchLabService = Depends(searchlab)) -> dict[str, Any]:
    return service.evaluate()


@router.get("/searchlab/health")
def health(service: SearchLabService = Depends(searchlab)) -> dict[str, Any]:
    return service.health()


@router.post("/searchlab/ask", dependencies=PAID)
def ask(body: SearchAsk, service: SearchLabService = Depends(searchlab)) -> dict[str, Any]:
    """An agent with the index as a function tool."""
    return service.ask(body.question)
