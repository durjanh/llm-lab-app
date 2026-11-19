"""Digital teammate: @mention an AI agent with its own identity in a team channel, and control it as its admin."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..schemas import ModelChoice
from ..services.teammate import TeammateService
from .deps import require_budget, require_lab_page, teammate

router = APIRouter(dependencies=[Depends(require_lab_page)])
NDJSON = {"media_type": "application/x-ndjson", "headers": {"Cache-Control": "no-store"}}


class Post(ModelChoice):
    text: str = Field(min_length=1, max_length=1000)


class Allocation(BaseModel):
    supplier_id: str = Field(max_length=10)
    batches: int = Field(ge=0, le=100)


class CoverageAsk(BaseModel):
    allocations: list[Allocation] = Field(max_length=10)
    internal: int | None = Field(default=None, ge=0, le=100)


class AdminChange(BaseModel):
    enabled: bool | None = None
    scopes: list[str] | None = Field(default=None, max_length=10)
    proactive: bool | None = None


@router.get("/teammate/info")
def info(service: TeammateService = Depends(teammate)) -> dict[str, Any]:
    return service.info()


@router.get("/teammate/state")
def state(service: TeammateService = Depends(teammate)) -> dict[str, Any]:
    """Every thread and message, the admin's settings and the activity log."""
    return service.state()


@router.post("/teammate/reset")
def reset(service: TeammateService = Depends(teammate)) -> dict[str, Any]:
    return service.reset()


@router.post("/teammate/posts", dependencies=[Depends(require_budget)])
def post(body: Post, service: TeammateService = Depends(teammate)) -> StreamingResponse:
    """A new post in the channel; the agent answers in its thread when @mentioned, streaming its steps as NDJSON."""
    return StreamingResponse(service.mention(body.text, body.model), **NDJSON)


@router.post("/teammate/threads/{thread_id}/replies", dependencies=[Depends(require_budget)])
def reply(thread_id: int, body: Post, service: TeammateService = Depends(teammate)) -> StreamingResponse:
    """A follow-up in one thread, with that thread's messages only."""
    return StreamingResponse(service.reply(thread_id, body.text, body.model), **NDJSON)


@router.post("/teammate/coverage")
def coverage(body: CoverageAsk, service: TeammateService = Depends(teammate)) -> dict[str, Any]:
    """The widget's sums: no model call, the same code the agent's check_coverage tool uses."""
    return service.coverage([a.model_dump() for a in body.allocations], body.internal)


@router.post("/teammate/admin")
def admin(body: AdminChange, service: TeammateService = Depends(teammate)) -> dict[str, Any]:
    """The admin's controls: on or off, which records it may read, and posts of its own. Logged."""
    return service.admin(body.enabled, body.scopes, body.proactive)


@router.post("/teammate/morning-check", dependencies=[Depends(require_budget)])
def morning_check(body: ModelChoice, service: TeammateService = Depends(teammate)) -> dict[str, Any]:
    """Runs the agent's scheduled check now: it may post a follow-up of its own, within the admin's limits."""
    return service.morning_check(body.model)
