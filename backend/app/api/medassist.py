"""MedAssist: a patient portal chat with a Microsoft Foundry prompt agent that books into a dummy practice database."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import MedAssistMessage, MedAssistStart
from ..services.medassist import MedAssistService
from .deps import medassist, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


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
