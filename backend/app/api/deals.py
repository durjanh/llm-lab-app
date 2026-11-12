"""Closed-deal agents: mark a deal closed-won, watch the chain of steps, then approve or reject each draft."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..schemas import ModelChoice
from ..services.deals import DealsService
from .deps import deals, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


class DealDecision(BaseModel):
    approve: bool


class ContactConsent(BaseModel):
    consent: bool


@router.get("/deals/info")
def info(service: DealsService = Depends(deals)) -> dict[str, Any]:
    return service.info()


@router.get("/deals/state")
def state(service: DealsService = Depends(deals)) -> dict[str, Any]:
    """The deals, every draft and decision, and how many emails are left today."""
    return service.state()


@router.post("/deals/reset")
def reset(service: DealsService = Depends(deals)) -> dict[str, Any]:
    """Puts the invented CRM back as it started."""
    return service.reset()


@router.post("/deals/{deal_id}/close", dependencies=[Depends(require_budget)])
def close(deal_id: str, body: ModelChoice, service: DealsService = Depends(deals)) -> StreamingResponse:
    """Marks the deal closed-won and streams the steps as NDJSON, ending with drafts awaiting approval."""
    return StreamingResponse(service.close(deal_id, body.model), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


@router.post("/deals/outreach/{outreach_id}/decision")
def decide(outreach_id: int, body: DealDecision, service: DealsService = Depends(deals)) -> dict[str, Any]:
    """A person's answer on one draft. No model call: code checks the rules again and records the result."""
    return service.decide(outreach_id, body.approve)


@router.get("/deals/contacts")
def contacts(service: DealsService = Depends(deals)) -> dict[str, Any]:
    return service.contacts()


@router.post("/deals/contacts/{contact_id}/consent")
def consent(contact_id: str, body: ContactConsent, service: DealsService = Depends(deals)) -> dict[str, Any]:
    """Changes a contact's agreement to email, to try the rule that is checked again at approval."""
    return service.set_consent(contact_id, body.consent)
