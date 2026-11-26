"""The software factory page: the backlog, a change run end to end as NDJSON, a person's decisions, Stop, revert,
reset, and the track record."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..services.software_factory import SoftwareFactoryService
from .deps import require_budget, require_lab_page, software_factory

router = APIRouter(dependencies=[Depends(require_lab_page)])
NDJSON = {"media_type": "application/x-ndjson", "headers": {"Cache-Control": "no-store"}}


class NewTicket(BaseModel):
    title: str = Field(max_length=200)
    description: str = Field(max_length=4000)
    kind: str = Field(max_length=40)
    area: str = Field(max_length=40)


class StartChange(BaseModel):
    ticket_id: str = Field(max_length=20)
    model: str = Field(max_length=100)
    effort: str = Field(default="low", max_length=10)


class Decision(BaseModel):
    run_id: str = Field(max_length=64)
    decision_id: str = Field(max_length=64)
    decision: str = Field(max_length=20)
    note: str = Field(default="", max_length=4000)
    plan: str | None = Field(default=None, max_length=10000)


class Revert(BaseModel):
    note: str = Field(default="", max_length=1000)


@router.get("/software-factory/info")
def info(service: SoftwareFactoryService = Depends(software_factory)) -> dict[str, Any]:
    """Models, the rules the factory applies, budgets and whether a sandbox is ready."""
    return service.info()


@router.get("/software-factory/state")
def state(service: SoftwareFactoryService = Depends(software_factory)) -> dict[str, Any]:
    """The backlog with tiers, every change, the track record by area, and the metrics."""
    return service.state()


@router.post("/software-factory/tickets")
def add_ticket(body: NewTicket, service: SoftwareFactoryService = Depends(software_factory)) -> dict[str, Any]:
    return service.add_ticket(body.title, body.description, body.kind, body.area)


@router.get("/software-factory/changes/{change_id}")
def change(change_id: str, service: SoftwareFactoryService = Depends(software_factory)) -> dict[str, Any]:
    """One change in full: plan, diff, tests, the reviewer's findings, the gates and the audit trail."""
    return service.change(change_id)


@router.post("/software-factory/changes", dependencies=[Depends(require_budget)])
def start(body: StartChange, service: SoftwareFactoryService = Depends(software_factory)) -> StreamingResponse:
    """Runs one ticket through the factory, streaming every step; waits for a person where the tier calls for one."""
    return StreamingResponse(service.start(body.ticket_id, body.model, body.effort), **NDJSON)


@router.post("/software-factory/decide", status_code=204)
def decide(body: Decision, service: SoftwareFactoryService = Depends(software_factory)) -> Response:
    """A person's answer to a plan or a diff: approve, reject, changes or take_over."""
    service.decide(body.run_id, body.decision_id, body.decision, body.note, body.plan)
    return Response(status_code=204)


@router.post("/software-factory/runs/{run_id}/stop", status_code=204)
def stop(run_id: str, service: SoftwareFactoryService = Depends(software_factory)) -> Response:
    service.stop(run_id)
    return Response(status_code=204)


@router.post("/software-factory/changes/{change_id}/revert")
def revert(change_id: str, body: Revert, service: SoftwareFactoryService = Depends(software_factory)) -> dict[str, Any]:
    """Reverts a merged change and records an escaped defect, which costs its area a level of autonomy."""
    return service.revert(change_id, body.note)


@router.post("/software-factory/reset", status_code=204)
def reset(service: SoftwareFactoryService = Depends(software_factory)) -> Response:
    """A fresh copy of the practice project, no changes and a new track record."""
    service.reset()
    return Response(status_code=204)
