"""Model failover: an agent that switches model in the middle of a conversation when one is rate limited or overloaded,
with the whole history kept in the lab's own store. Conversations, one message at a time (streamed), the router's breakers,
fault injection and compaction settings."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Path, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..core.errors import ApiError
from ..services.model_failover import MAX_MESSAGE, ModelFailoverService
from .deps import model_failover, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])
CONV = r"^[0-9a-f]{12}$"
NDJSON = {"Cache-Control": "no-store"}


class Message(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_MESSAGE)
    primary: str | None = Field(default=None, max_length=80)


class Resume(BaseModel):
    primary: str | None = Field(default=None, max_length=80)


class Fault(BaseModel):
    pool: str = Field(min_length=1, max_length=80)
    kind: Literal["429", "429_short", "529", "500", "timeout"]
    count: int = Field(default=1, ge=1, le=10)


class Overrides(BaseModel):
    """Per-conversation compaction settings. Leave one out (or null) to use the server's default."""
    compact_at: float | None = Field(default=None, ge=0.2, le=0.95)
    compact_max_tokens: int | None = Field(default=None, ge=4000, le=2_000_000)
    keep_recent: int | None = Field(default=None, ge=1, le=20)


class CatalogModel(BaseModel):
    """One model in the fallback order. Prices (dollars per million tokens) are for a model PRICES does not list."""
    model_config = ConfigDict(extra="ignore")
    model: str = Field(min_length=1, max_length=120)
    provider: str = Field(default="anthropic", max_length=40)
    context_window: int = Field(default=200_000, ge=4000, le=10_000_000)
    name: str = Field(default="", max_length=80)
    note: str = Field(default="", max_length=120)
    enabled: bool = True
    input_per_m: float | None = Field(default=None, ge=0)
    output_per_m: float | None = Field(default=None, ge=0)
    cache_read_per_m: float | None = Field(default=None, ge=0)


class CatalogBody(BaseModel):
    models: list[CatalogModel] = Field(min_length=1, max_length=12)
    compact_model: str = Field(min_length=1, max_length=120)
    version: str | None = Field(default=None, max_length=200)


@router.get("/model-failover/catalog")
def get_catalog(service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    """The models in fallback order, where they are read from, the version, the last error and what is available. Free."""
    return service.catalog()


@router.put("/model-failover/catalog")
def put_catalog(body: CatalogBody, if_match: str | None = Header(default=None, max_length=200),
                service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    """Saves the list. The version it was loaded at goes in the body or an If-Match header: 400 for a rule broken, 409 if
    it changed since. It takes effect on the next model call."""
    version = (body.version or "").strip() or (if_match or "").strip().strip('"')  # an empty body field defers to the header
    if not version:
        raise ApiError(400, "invalid_request", "version: send the version you loaded (in the body or an If-Match header).")
    document = {"compact_model": body.compact_model,
                "models": [m.model_dump(exclude_none=True, exclude_defaults=False) for m in body.models]}
    return service.save_catalog(document, version)


@router.post("/model-failover/catalog/reload")
def reload_catalog(service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    """Reads the source again now, instead of waiting for the next check. A bad edit keeps the last good list."""
    return service.reload_catalog()


@router.get("/model-failover/info")
def info(service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    """The pools and their breakers, where history is stored, the tools, the limits and the compaction defaults. Free."""
    return service.info()


@router.get("/model-failover/router")
def router_status(service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    return service.router_status()


@router.post("/model-failover/router/reset")
def router_reset(service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    """Closes every breaker and drops every injected fault."""
    return service.reset_router()


@router.post("/model-failover/faults")
def inject(body: Fault, service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    """The next `count` calls to a pool fail with this fault. Raised before any request is sent, so it costs nothing."""
    return service.inject(body.pool, body.kind, body.count)


@router.delete("/model-failover/faults")
def clear_faults(pool: str | None = Query(default=None, max_length=80),
                 service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    return service.clear_faults(pool)


@router.get("/model-failover/conversations")
def list_conversations(service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    return {"conversations": service.list_conversations()}


@router.post("/model-failover/conversations")
def create_conversation(service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    return service.create_conversation()


Conv = Path(pattern=CONV)


@router.get("/model-failover/conversations/{conv_id}")
def get_conversation(conv_id: str = Conv, primary: str | None = Query(default=None, max_length=80),
                     service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    """The steps in order, each with the model that produced it, the memory panel and where the data is stored."""
    return service.get_conversation(conv_id, primary)


@router.delete("/model-failover/conversations/{conv_id}")
def delete_conversation(conv_id: str = Conv, service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    service.delete_conversation(conv_id)
    return {"deleted": conv_id}


@router.put("/model-failover/conversations/{conv_id}/settings")
def set_settings(body: Overrides, conv_id: str = Conv,
                 service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    """This conversation's compaction settings. Out of range is a 400."""
    return service.set_overrides(conv_id, body.model_dump())


@router.post("/model-failover/conversations/{conv_id}/messages", dependencies=[Depends(require_budget)])
def send_message(body: Message, conv_id: str = Conv,
                 service: ModelFailoverService = Depends(model_failover)) -> StreamingResponse:
    """One message through the agent, streamed as NDJSON: steps, retries, switches, compactions and the answer."""
    return StreamingResponse(service.send(conv_id, body.message, body.primary), media_type="application/x-ndjson",
                             headers=NDJSON)


@router.post("/model-failover/conversations/{conv_id}/resume", dependencies=[Depends(require_budget)])
def resume(body: Resume, conv_id: str = Conv,
           service: ModelFailoverService = Depends(model_failover)) -> StreamingResponse:
    """Finishes a turn that stopped part way (an error, a crash), from the last whole step."""
    return StreamingResponse(service.resume(conv_id, body.primary), media_type="application/x-ndjson", headers=NDJSON)


@router.post("/model-failover/conversations/{conv_id}/compact", dependencies=[Depends(require_budget)])
def compact(body: Resume, conv_id: str = Conv,
            service: ModelFailoverService = Depends(model_failover)) -> dict[str, Any]:
    """Compacts now, whatever the threshold (the lab's button). The summary is a paid call."""
    return service.compact_now(conv_id, body.primary)
