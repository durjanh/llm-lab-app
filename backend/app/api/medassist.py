"""MedAssist: a patient portal chat with a Microsoft Foundry prompt agent that books into a dummy practice database."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from ..schemas import MedAssistMessage, MedAssistStart
from ..services.medassist import MedAssistService
from ..services.medassist_phone import MedAssistPhone
from .deps import medassist, medassist_phone, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])
# The practice's phone line hears from Event Grid (a call is coming in) and Call Automation (what happens on it),
# from the internet through a tunnel, so it cannot send the lab's header: each address carries a token instead.
LINE = "/api/medassist/phone/"
phone_events = APIRouter()


@router.get("/medassist/info")
def info(service: MedAssistService = Depends(medassist)) -> dict[str, Any]:
    return service.info()


@router.post("/medassist/chats", dependencies=[Depends(require_budget)])
def start(body: MedAssistStart, service: MedAssistService = Depends(medassist)) -> dict[str, Any]:
    """A new conversation for a signed-in patient. The portal, not the model, says who that is."""
    return service.start(body.patient_id)


@router.post("/medassist/chats/{chat_id}/messages", dependencies=[Depends(require_budget)])
def message(chat_id: str, body: MedAssistMessage, service: MedAssistService = Depends(medassist)) -> dict[str, Any]:
    return service.message(chat_id, body.message.strip())


@router.delete("/medassist/chats/{chat_id}")
def end(chat_id: str, service: MedAssistService = Depends(medassist)) -> dict[str, Any]:
    return service.end(chat_id)


@router.get("/medassist/patients/{patient_id}")
def state(patient_id: str, service: MedAssistService = Depends(medassist)) -> dict[str, Any]:
    """What the practice's systems hold for the patient: record, appointments, texts sent, audit log."""
    return service.state(patient_id)


@router.post("/medassist/reset")
def reset(service: MedAssistService = Depends(medassist)) -> dict[str, Any]:
    return service.reset()


@router.get("/medassist/phone")
def phone_info(service: MedAssistPhone = Depends(medassist_phone)) -> dict[str, Any]:
    """Whether the practice's phone line is set up, and the settings still missing if not."""
    return service.info()


@phone_events.post("/medassist/phone/incoming")  # LINE, under /api
async def phone_incoming(token: str, request: Request, service: MedAssistPhone = Depends(medassist_phone)) -> dict[str, Any]:
    """Event Grid: a call to the lab's number (or Event Grid checking this address when the subscription is made)."""
    events = await request.json()
    return service.incoming(token, events if isinstance(events, list) else [events])


@phone_events.post("/medassist/phone/events/{call_id}")
async def phone_call_events(call_id: str, token: str, request: Request,
                            service: MedAssistPhone = Depends(medassist_phone)) -> dict[str, Any]:
    events = await request.json()
    service.events(call_id, token, events if isinstance(events, list) else [events])
    return {"ok": True}
