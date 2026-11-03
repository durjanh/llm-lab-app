"""The case-handling lab: cases, a streamed agent run, the caseworker's decision, the audit trail and the release gate."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..schemas import CaseDecision
from ..services.casework import CaseworkService
from .deps import casework, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])
NDJSON = {"media_type": "application/x-ndjson", "headers": {"Cache-Control": "no-store"}}


@router.get("/casework/info")
def info(service: CaseworkService = Depends(casework)) -> dict[str, Any]:
    return service.info()


@router.post("/casework/cases/{case_id}/run", dependencies=[Depends(require_budget)])
def run(case_id: str, service: CaseworkService = Depends(casework)) -> StreamingResponse:
    """The agents work the case; each step is streamed as it finishes, ending with a draft awaiting approval."""
    service.model()  # fail fast, before streaming, when Azure is not set up
    return StreamingResponse(service.stream(case_id), **NDJSON)


@router.post("/casework/runs/{run_id}/decision")
def decide(run_id: str, body: CaseDecision, service: CaseworkService = Depends(casework)) -> dict[str, Any]:
    return service.decide(run_id, body.action, body.reviewer.strip(), body.letter, body.note)


@router.get("/casework/audit")
def audit(case_id: str | None = None, service: CaseworkService = Depends(casework)) -> dict[str, Any]:
    return service.audit_trail(case_id)


@router.post("/casework/evaluate", dependencies=[Depends(require_budget)])
def evaluate(service: CaseworkService = Depends(casework)) -> StreamingResponse:
    service.model()
    return StreamingResponse(service.evaluate(), **NDJSON)
