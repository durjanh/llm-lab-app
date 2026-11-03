"""Live agent runs. Each streams newline-delimited JSON: a {"type": "run"} line, the run's own events,
then {"type": "final"}, {"type": "files"} or {"type": "error"}."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import Response, StreamingResponse

from ..schemas import ApproveRequest, HarnessRequest, SkillsRequest
from ..services.harness import HarnessService
from ..services.skills import SkillsService
from .deps import harness_service, require_budget, require_lab_page, skills_service

router = APIRouter(dependencies=[Depends(require_lab_page)])
NDJSON = {"media_type": "application/x-ndjson", "headers": {"Cache-Control": "no-store"}}


@router.post("/harness/run", dependencies=[Depends(require_budget)])
def harness_run(body: HarnessRequest, service: HarnessService = Depends(harness_service)) -> StreamingResponse:
    return StreamingResponse(service.run(body.scenario, body.number, body.task, body.model, body.effort), **NDJSON)


@router.post("/harness/approve")
def harness_approve(body: ApproveRequest, service: HarnessService = Depends(harness_service)) -> dict[str, Any]:
    """Answers a bash command that is waiting for a person."""
    service.approve(body.run_id, body.tool_use_id, body.allow)
    return {"ok": True}


@router.post("/skills/run", dependencies=[Depends(require_budget)])
def skills_run(body: SkillsRequest, service: SkillsService = Depends(skills_service)) -> StreamingResponse:
    return StreamingResponse(service.run(body.skill, body.upto, body.model), **NDJSON)


@router.get("/skills/files/{file_id}")
def skills_file(file_id: str, service: SkillsService = Depends(skills_service)) -> Response:
    name, media_type, content = service.download(file_id)
    return Response(content, media_type=media_type,
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})
