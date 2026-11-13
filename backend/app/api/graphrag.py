"""GraphRAG: a knowledge graph built from a vector database collection, searched beside plain vector retrieval.
Building the graph and answering are paid model calls, so both are guarded; reading the graph is free."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import Field

from ..schemas import ModelChoice
from ..services.graphrag import GraphRagService
from .deps import graphrag, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])

Collection = Field(min_length=1, max_length=80, pattern=r"^[\w .,()'&-]+$")


class GraphBuild(ModelChoice):
    collection: str = Collection


class GraphAsk(ModelChoice):
    collection: str = Collection
    question: str = Field(min_length=1, max_length=500)
    mode: Literal["vector", "local", "global"]


@router.get("/graphrag/status")
def status(model: str | None = None, service: GraphRagService = Depends(graphrag)) -> dict[str, Any]:
    """The collections in the vector database, what each graph holds, and the cost of building one."""
    return service.status(ModelChoice(model=model).model)


@router.post("/graphrag/sample")
def sample(service: GraphRagService = Depends(graphrag)) -> dict[str, Any]:
    """Loads the invented company memos into the vector database (free: the local model embeds them)."""
    return service.load_sample()


@router.get("/graphrag/graph")
def graph(collection: str, service: GraphRagService = Depends(graphrag)) -> dict[str, Any]:
    return service.graph_of(collection)


@router.post("/graphrag/build", dependencies=[Depends(require_budget)])
def build(body: GraphBuild, service: GraphRagService = Depends(graphrag)) -> StreamingResponse:
    """Builds the collection's graph, streamed as newline-delimited JSON."""
    return StreamingResponse(service.build(body.collection, body.model), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


@router.post("/graphrag/ask", dependencies=[Depends(require_budget)])
def ask(body: GraphAsk, service: GraphRagService = Depends(graphrag)) -> dict[str, Any]:
    """One answer, by plain vector RAG, by the graph's local search, or by its global search."""
    return service.ask(body.collection, body.question.strip(), body.mode, body.model)
