"""The vector database page: PostgreSQL with pgvector, filled and searched with the local embedding model. Adding and
searching cost nothing (both run on this machine); only an answer written by a model is paid, and guarded."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, StringConstraints

from ..schemas import ModelChoice
from ..services.vectordb import VectorDbService
from .deps import require_budget, require_lab_page, vectordb

router = APIRouter(dependencies=[Depends(require_lab_page)])

Name = Field(min_length=1, max_length=80, pattern=r"^[\w .,()'&-]+$")
Tag = Annotated[str, StringConstraints(min_length=1, max_length=30, pattern=r"^[a-z0-9-]+$")]


class VectorAdd(BaseModel):
    collection: str = Name
    source: str = Name
    text: str = Field(min_length=1, max_length=200_000)
    access: str = "everyone"  # who may read it: everyone, hr or managers
    tags: list[Tag] = Field(default_factory=list, max_length=8)


class VectorRemove(BaseModel):
    collection: str = Name
    source: str | None = Field(default=None, min_length=1, max_length=80)  # none: the whole collection


class VectorSearch(ModelChoice):
    collection: str = Name
    query: str = Field(min_length=1, max_length=500)
    k: int = Field(default=5, ge=1, le=20)
    reader: str | None = None  # search as this person: row-level security hides what they may not read
    tags: list[Tag] = Field(default_factory=list, max_length=8)  # only chunks with any of these tags


@router.get("/vectordb/status")
def status(service: VectorDbService = Depends(vectordb)) -> dict[str, Any]:
    """The embedding model, the database, and what it holds."""
    return service.status()


@router.post("/vectordb/documents")
def add(body: VectorAdd, service: VectorDbService = Depends(vectordb)) -> dict[str, Any]:
    """Chunks, embeds and stores a document, replacing an earlier copy with the same name."""
    return service.add(body.collection, body.source.strip(), body.text, body.access, body.tags)


@router.post("/vectordb/samples/{key}")
def add_samples(key: str, service: VectorDbService = Depends(vectordb)) -> dict[str, Any]:
    """Loads one of the invented sample collections."""
    return service.add_samples(key)


@router.post("/vectordb/remove")
def remove(body: VectorRemove, service: VectorDbService = Depends(vectordb)) -> dict[str, Any]:
    return service.remove(body.collection, body.source)


@router.post("/vectordb/search")
def search(body: VectorSearch, service: VectorDbService = Depends(vectordb)) -> dict[str, Any]:
    """The top chunks by meaning, by words and both fused, with the SQL that found them."""
    return service.search(body.collection, body.query.strip(), body.k, body.reader, body.tags)


@router.post("/vectordb/answer", dependencies=[Depends(require_budget)])
def answer(body: VectorSearch, service: VectorDbService = Depends(vectordb)) -> dict[str, Any]:
    """A model's answer from the fused results, with its citations checked."""
    return service.answer(body.collection, body.query.strip(), body.k, body.model, body.reader, body.tags)
