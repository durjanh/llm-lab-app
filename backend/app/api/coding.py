"""The coding agent: the hand-built harness in python/19_coding_agent.py, and the same agent on the Agent SDK."""
from __future__ import annotations

import mimetypes
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import Response, StreamingResponse

from ..schemas import ApproveRequest, CodingRun, CodingSdkRun, CodingSession
from ..services.coding import MAX_UPLOAD_BYTES, CodingService
from .deps import coding, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])
downloads = APIRouter()  # a download link cannot send the lab header; the session id, 128 random bits, is the key
NDJSON = {"media_type": "application/x-ndjson", "headers": {"Cache-Control": "no-store"}}


@router.get("/coding/info")
def info(service: CodingService = Depends(coding)) -> dict[str, Any]:
    """The preset tasks, the permission modes and rules, and whether the Agent SDK example is installed."""
    return service.info()


@router.post("/coding/run", dependencies=[Depends(require_budget)])
def run(body: CodingRun, service: CodingService = Depends(coding)) -> StreamingResponse:
    """One request to the agent; every call, diff, prompt and to-do list is streamed as it happens."""
    return StreamingResponse(service.run(body.prompt.strip(), body.session_id, body.mode, body.model), **NDJSON)


@router.post("/coding/sdk-run", dependencies=[Depends(require_budget)])
def sdk_run(body: CodingSdkRun, service: CodingService = Depends(coding)) -> StreamingResponse:
    """The same request to the Agent SDK version, in a fresh copy of the project."""
    return StreamingResponse(service.sdk_run(body.prompt.strip(), body.mode, body.model), **NDJSON)


@router.post("/coding/approve")
def approve(body: ApproveRequest, service: CodingService = Depends(coding)) -> dict[str, Any]:
    service.approve(body.run_id, body.tool_use_id, body.allow)
    return {"ok": True}


@router.post("/coding/sessions")
def create(body: CodingSession, service: CodingService = Depends(coding)) -> dict[str, Any]:
    """A session before its first request: the practice project, or an empty workspace for your own files."""
    return service.create(body.workspace)


@router.post("/coding/sessions/{session_id}/files")
async def add_file(session_id: str, file: UploadFile = File(...),
                   service: CodingService = Depends(coding)) -> dict[str, Any]:
    """Puts a file in the workspace's inputs/ folder; the agent hears of it at its next request."""
    return service.add_file(session_id, file.filename or "file", await file.read(MAX_UPLOAD_BYTES + 1))


@router.post("/coding/sessions/{session_id}/sample")
def add_sample(session_id: str, service: CodingService = Depends(coding)) -> dict[str, Any]:
    """Adds the invented sample workbook to inputs/."""
    return service.add_sample(session_id)


@downloads.get("/coding/sessions/{session_id}/download")
def download(session_id: str, path: str, service: CodingService = Depends(coding)) -> Response:
    content, name = service.download(session_id, path)
    return Response(content, media_type=mimetypes.guess_type(name)[0] or "application/octet-stream",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}",
                             "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/coding/sessions/{session_id}")
def state(session_id: str, service: CodingService = Depends(coding)) -> dict[str, Any]:
    return service.state(session_id)


@router.get("/coding/sessions/{session_id}/file")
def file(session_id: str, path: str, service: CodingService = Depends(coding)) -> dict[str, Any]:
    return service.file(session_id, path)


@router.post("/coding/sessions/{session_id}/undo")
def undo(session_id: str, service: CodingService = Depends(coding)) -> dict[str, Any]:
    """Puts back the file the agent changed last. The agent is told at its next request."""
    return service.undo(session_id)
