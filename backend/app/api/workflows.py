"""Live Agent Framework workflows. A run streams newline-delimited JSON: a {"type": "run"} line, the workflow's own
events, then {"type": "final"} or {"type": "error"}."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..schemas import ApproveRequest, WorkflowRequest
from ..services.workflows import WorkflowService
from .deps import require_budget, require_lab_page, workflows

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.post("/workflows/run", dependencies=[Depends(require_budget)])
def workflow_run(body: WorkflowRequest, service: WorkflowService = Depends(workflows)) -> StreamingResponse:
    return StreamingResponse(service.run(body.pattern, body.task), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


@router.post("/workflows/approve")
def workflow_approve(body: ApproveRequest, service: WorkflowService = Depends(workflows)) -> dict[str, Any]:
    """Answers a workflow that has stopped for a person."""
    service.approve(body.run_id, body.tool_use_id, body.allow)
    return {"ok": True}
