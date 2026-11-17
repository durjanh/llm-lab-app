"""Memory stores: create stores, read and change their memories, see each memory's versions, restore or redact one.
Nothing here calls a model, so no route needs the budget."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field

from ..services.memory_stores import MAX_MEMORY_BYTES, MemoryStores
from .deps import memory_stores, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])
StoreId = Annotated[str, Path(pattern=r"^memstore_[0-9a-f]{16}$")]
MemoryId = Annotated[str, Path(pattern=r"^mem_[0-9a-f]{16}$")]
VersionId = Annotated[str, Path(pattern=r"^memver_[0-9a-f]{16}$")]


class NewStore(BaseModel):
    name: str = Field(min_length=2, max_length=41)
    description: str = Field(default="", max_length=2000)


class Description(BaseModel):
    description: str = Field(max_length=2000)


class NewMemory(BaseModel):
    path: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=MAX_MEMORY_BYTES)


class Content(BaseModel):
    content: str = Field(max_length=MAX_MEMORY_BYTES)


@router.get("/memory-stores")
def stores(service: MemoryStores = Depends(memory_stores)) -> list[dict[str, Any]]:
    return service.list()


@router.post("/memory-stores")
def create(body: NewStore, service: MemoryStores = Depends(memory_stores)) -> dict[str, Any]:
    return service.create(body.name, body.description)


@router.get("/memory-stores/{store_id}")
def store(store_id: StoreId, service: MemoryStores = Depends(memory_stores)) -> dict[str, Any]:
    return service.get(store_id)


@router.patch("/memory-stores/{store_id}")
def describe(store_id: StoreId, body: Description, service: MemoryStores = Depends(memory_stores)) -> dict[str, Any]:
    return service.describe(store_id, body.description)


@router.delete("/memory-stores/{store_id}")
def delete_store(store_id: StoreId, service: MemoryStores = Depends(memory_stores)) -> dict[str, Any]:
    return service.delete_store(store_id)


@router.post("/memory-stores/{store_id}/memories")
def add(store_id: StoreId, body: NewMemory, service: MemoryStores = Depends(memory_stores)) -> dict[str, Any]:
    return service.add(store_id, body.path, body.content)


@router.get("/memory-stores/{store_id}/memories/{memory_id}")
def memory(store_id: StoreId, memory_id: MemoryId, service: MemoryStores = Depends(memory_stores)) -> dict[str, Any]:
    return service.memory(store_id, memory_id)


@router.put("/memory-stores/{store_id}/memories/{memory_id}")
def update(store_id: StoreId, memory_id: MemoryId, body: Content,
           service: MemoryStores = Depends(memory_stores)) -> dict[str, Any]:
    return service.update(store_id, memory_id, body.content)


@router.delete("/memory-stores/{store_id}/memories/{memory_id}")
def delete(store_id: StoreId, memory_id: MemoryId, service: MemoryStores = Depends(memory_stores)) -> dict[str, Any]:
    return service.delete(store_id, memory_id)


@router.get("/memory-stores/{store_id}/versions/{version_id}")
def version(store_id: StoreId, version_id: VersionId, service: MemoryStores = Depends(memory_stores)) -> dict[str, Any]:
    return service.version(store_id, version_id)


@router.post("/memory-stores/{store_id}/versions/{version_id}/restore")
def restore(store_id: StoreId, version_id: VersionId, service: MemoryStores = Depends(memory_stores)) -> dict[str, Any]:
    return service.restore(store_id, version_id)


@router.post("/memory-stores/{store_id}/versions/{version_id}/redact")
def redact(store_id: StoreId, version_id: VersionId, service: MemoryStores = Depends(memory_stores)) -> dict[str, Any]:
    return service.redact(store_id, version_id)
