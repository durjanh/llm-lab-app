"""Aftercare: post-discharge follow-up calls by a Claude or Microsoft Agent Framework agent, written back to a dummy record."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from ..schemas import AftercareEvaluate, AftercareMessage, AftercareStart, AftercareTaskClose
from ..services.aftercare import AftercareService
from ..services.aftercare_phone import AftercarePhone
from .deps import aftercare, aftercare_phone, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])
# Communication Services reports a real call's events here, from the internet through a tunnel, so it cannot send
# the lab's header: each call's address carries a token made for that call instead.
CALL_EVENTS = "/api/aftercare/phone/events/"
phone_events = APIRouter()
NDJSON = {"media_type": "application/x-ndjson", "headers": {"Cache-Control": "no-store"}}


@router.get("/aftercare/info")
def info(service: AftercareService = Depends(aftercare)) -> dict[str, Any]:
    return service.info()


@router.get("/aftercare/board")
def board(service: AftercareService = Depends(aftercare)) -> dict[str, Any]:
    """The worklist and the care team's open tasks."""
    return service.board()


@router.get("/aftercare/patients/{patient_id}")
def record(patient_id: str, service: AftercareService = Depends(aftercare)) -> dict[str, Any]:
    """What the hospital record holds for one patient: checks, tasks, appointments, texts, transcript, audit."""
    return service.record(patient_id)


@router.post("/aftercare/calls", dependencies=[Depends(require_budget)])
def start(body: AftercareStart, service: AftercareService = Depends(aftercare)) -> dict[str, Any]:
    """Starts the wave that is due; the agent writes the first message."""
    return service.start(body.patient_id, body.engine, body.model)


@router.post("/aftercare/calls/{call_id}/messages", dependencies=[Depends(require_budget)])
def message(call_id: str, body: AftercareMessage, service: AftercareService = Depends(aftercare)) -> dict[str, Any]:
    return service.message(call_id, body.message.strip())


@router.post("/aftercare/calls/{call_id}/simulate", dependencies=[Depends(require_budget)])
def simulate(call_id: str, service: AftercareService = Depends(aftercare)) -> dict[str, Any]:
    """The simulated patient (Claude Haiku) answers, then the agent replies."""
    return service.message(call_id, "", simulate=True)


@router.delete("/aftercare/calls/{call_id}")
def end(call_id: str, service: AftercareService = Depends(aftercare)) -> dict[str, Any]:
    return service.end(call_id)


@router.post("/aftercare/tasks/{task_id}/close")
def close_task(task_id: int, body: AftercareTaskClose, service: AftercareService = Depends(aftercare)) -> dict[str, Any]:
    """A nurse closes a task: the human end of the loop."""
    return service.close_task(task_id, body.note)


@router.post("/aftercare/reset")
def reset(service: AftercareService = Depends(aftercare)) -> dict[str, Any]:
    return service.reset()


@router.post("/aftercare/evaluate", dependencies=[Depends(require_budget)])
def evaluate(body: AftercareEvaluate, service: AftercareService = Depends(aftercare)) -> StreamingResponse:
    """The scripted patients through whole calls on one engine, each checked on what it left in the record."""
    return StreamingResponse(service.evaluate(body.engine, body.model, body.patients), **NDJSON)


@router.get("/aftercare/phone")
def phone_info(service: AftercarePhone = Depends(aftercare_phone)) -> dict[str, Any]:
    """Whether real calls are set up, and the settings still missing if not."""
    return service.info()


@router.post("/aftercare/phone", dependencies=[Depends(require_budget)])
def phone_call(body: AftercareStart, service: AftercarePhone = Depends(aftercare_phone)) -> dict[str, Any]:
    """Starts an Aftercare call and rings your own phone with it."""
    return service.start(body.patient_id, body.engine, body.model)


@router.get("/aftercare/phone/{call_id}")
def phone_status(call_id: str, service: AftercarePhone = Depends(aftercare_phone)) -> dict[str, Any]:
    return service.status(call_id)


@phone_events.post("/aftercare/phone/events/{call_id}")  # CALL_EVENTS, under /api
async def phone_call_events(call_id: str, token: str, request: Request,
                            service: AftercarePhone = Depends(aftercare_phone)) -> dict[str, Any]:
    events = await request.json()
    service.events(call_id, token, events if isinstance(events, list) else [events])
    return {"ok": True}
