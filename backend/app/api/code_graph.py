"""The code knowledge graph: analyse a code base into a graph, read one node, and ask questions about it."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..schemas import ModelChoice
from ..services.code_graph import CodeGraphService
from .deps import code_graph, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


class GraphSource(BaseModel):
    source: str = Field(pattern="^(lab|github)$")
    url: str = Field(default="", max_length=300)


class GraphUpload(BaseModel):
    name: str = Field(default="upload.zip", max_length=200)
    data: str = Field(min_length=10, max_length=36_000_000)  # a ZIP, base64: about 25 MB


class GraphQuestion(ModelChoice):
    question: str = Field(min_length=1, max_length=2000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=20)


@router.get("/code-graph/info")
def info(service: CodeGraphService = Depends(code_graph)) -> dict[str, Any]:
    return service.info()


@router.post("/code-graph/analyse")
def analyse(body: GraphSource, service: CodeGraphService = Depends(code_graph)) -> dict[str, Any]:
    """This lab's code, or a public GitHub repository. Code does the analysis; no model is called."""
    return service.analyse_lab() if body.source == "lab" else service.analyse_github(body.url)


@router.post("/code-graph/upload")
def upload(body: GraphUpload, service: CodeGraphService = Depends(code_graph)) -> dict[str, Any]:
    return service.analyse_upload(body.name, body.data)


@router.get("/code-graph/{graph_id}")
def graph(graph_id: str, service: CodeGraphService = Depends(code_graph)) -> dict[str, Any]:
    return service.graph(graph_id)


@router.get("/code-graph/{graph_id}/node")
def node(graph_id: str, id: str, service: CodeGraphService = Depends(code_graph)) -> dict[str, Any]:
    """One node's code and links, for the side panel."""
    return service.node(graph_id, id)


@router.post("/code-graph/{graph_id}/ask", dependencies=[Depends(require_budget)])
def ask(graph_id: str, body: GraphQuestion, service: CodeGraphService = Depends(code_graph)) -> dict[str, Any]:
    return service.ask(graph_id, body.question.strip(), body.history, body.model)
