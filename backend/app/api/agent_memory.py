"""Agent memory, live: people, sessions, messages, the clock and the memory store. Messages and the end of a session
call Claude, so they need the budget too."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field

from ..services.agent_memory import AgentMemoryService
from .deps import agent_memory, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])
User = Annotated[str, Path(pattern=r"^[a-z][a-z0-9-]{1,30}$")]
Session = Annotated[str, Path(pattern=r"^[0-9a-f]{8}$")]


class Message(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    model: str | None = Field(default=None, max_length=60)
    careless: bool = False  # tell the model to keep everything, to show the privacy guard catching it


class End(BaseModel):
    model: str | None = Field(default=None, max_length=60)


class Clock(BaseModel):
    days: int = Field(ge=1, le=365)


@router.get("/agent-memory/info")
def info(service: AgentMemoryService = Depends(agent_memory)) -> dict[str, Any]:
    return service.info()


@router.get("/agent-memory/people/{user}")
def state(user: User, service: AgentMemoryService = Depends(agent_memory)) -> dict[str, Any]:
    return service.state(user)


@router.delete("/agent-memory/people/{user}")
def reset(user: User, service: AgentMemoryService = Depends(agent_memory)) -> dict[str, Any]:
    return service.reset(user)


@router.post("/agent-memory/people/{user}/clock")
def advance(user: User, body: Clock, service: AgentMemoryService = Depends(agent_memory)) -> dict[str, Any]:
    return service.advance(user, body.days)


@router.post("/agent-memory/people/{user}/sessions")
def start(user: User, service: AgentMemoryService = Depends(agent_memory)) -> dict[str, Any]:
    return service.start(user)


@router.post("/agent-memory/people/{user}/sessions/{sid}/messages", dependencies=[Depends(require_budget)])
def message(user: User, sid: Session, body: Message, service: AgentMemoryService = Depends(agent_memory)) -> dict[str, Any]:
    return service.message(user, sid, body.text, body.model, body.careless)


@router.post("/agent-memory/people/{user}/sessions/{sid}/end", dependencies=[Depends(require_budget)])
def end(user: User, sid: Session, body: End, service: AgentMemoryService = Depends(agent_memory)) -> dict[str, Any]:
    return service.end(user, sid, body.model)
