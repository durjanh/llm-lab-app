"""Tabular foundation models: a table (uploaded or a sample), the agent's suggested target, and the comparison."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..services.tabular import MAX_UPLOAD_BYTES, TabularService
from .deps import require_budget, require_lab_page, tabular

router = APIRouter(dependencies=[Depends(require_lab_page)])


class TabularSuggest(BaseModel):
    table_id: str = Field(min_length=16, max_length=16)
    model: str | None = None


class TabularRun(TabularSuggest):
    target: str = Field(min_length=1, max_length=200)
    task: Literal["classification", "regression"]
    test_size: float = Field(default=0.25, ge=0.1, le=0.5)
    seed: int = Field(default=0, ge=0, le=10_000)


@router.get("/tabular/info")
def info(service: TabularService = Depends(tabular)) -> dict[str, Any]:
    return service.info()


@router.post("/tabular/tables")
async def upload(file: UploadFile = File(...), service: TabularService = Depends(tabular)) -> dict[str, Any]:
    """A CSV, checked and summarised. Nothing is sent to a model."""
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    return service.upload(raw, file.filename or "upload.csv")


@router.post("/tabular/samples/{sample_id}")
def sample(sample_id: str, service: TabularService = Depends(tabular)) -> dict[str, Any]:
    return service.sample(sample_id)


@router.post("/tabular/suggest", dependencies=[Depends(require_budget)])
def suggest(body: TabularSuggest, service: TabularService = Depends(tabular)) -> dict[str, Any]:
    """The model proposes what to predict, from the column summary only; code checks it."""
    return service.suggest(body.table_id, body.model)


@router.post("/tabular/run", dependencies=[Depends(require_budget)])
def run(body: TabularRun, service: TabularService = Depends(tabular)) -> StreamingResponse:
    """Both models on the table, then the explanation, streamed as NDJSON."""
    return StreamingResponse(service.run(body.table_id, body.target, body.task, body.model, body.test_size, body.seed),
                             media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
