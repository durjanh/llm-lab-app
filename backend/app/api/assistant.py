"""The assistant page: chats, uploads, a turn streamed as NDJSON, plan approval, Stop, compaction, and made files."""
from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from ..core.body_limit import FORM_OVERHEAD, LimitedRoute, limit
from ..services.assistant import AssistantService
from ..services.assistant_store import MAX_FILE_BYTES, MAX_FILES
from .deps import assistant, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)], route_class=LimitedRoute)
media = APIRouter()  # <img>, <iframe> and download links cannot send the lab header; the chat id (128 bits) is the key
NDJSON = {"media_type": "application/x-ndjson", "headers": {"Cache-Control": "no-store"}}


class Rename(BaseModel):
    title: str = Field(max_length=500)


class Send(BaseModel):
    text: str = Field(max_length=40_000)
    attachments: list[str] = Field(default_factory=list, max_length=50)
    model: str
    effort: str = ""
    run_budget_usd: float = 1.0
    approve_plans: bool = False
    mcp_servers: list[str] | None = Field(default=None, max_length=20)
    auto: bool = False
    deck_brand: str | None = Field(default=None, max_length=40)  # a brand kit's id; "" for the house style


class McpAdd(BaseModel):
    name: str = Field(max_length=200)
    url: str = Field(max_length=2000)
    token: str | None = Field(default=None, max_length=8000)
    ask_before_call: bool = True


class McpPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    url: str | None = Field(default=None, max_length=2000)
    token: str | None = Field(default=None, max_length=8000)
    enabled: bool | None = None
    ask_before_call: bool | None = None


class PlanStep(BaseModel):
    text: str = Field(max_length=1000)
    status: str = "todo"


class Approve(BaseModel):
    run_id: str = Field(max_length=64)
    approval_id: str = Field(max_length=64)
    decision: str
    steps: list[PlanStep] | None = Field(default=None, max_length=30)
    note: str = Field(default="", max_length=2000)


@router.get("/assistant/info")
def info(service: AssistantService = Depends(assistant)) -> dict[str, Any]:
    """The models and the efforts each takes, the defaults, the upload limits and whether the sandbox is up."""
    return service.info()


@router.get("/assistant/chats")
def chats(service: AssistantService = Depends(assistant)) -> list[dict[str, Any]]:
    return service.list_chats()


@router.post("/assistant/chats")
def create(service: AssistantService = Depends(assistant)) -> dict[str, Any]:
    return service.create_chat()


@router.get("/assistant/chats/{chat_id}")
def chat(chat_id: str, service: AssistantService = Depends(assistant)) -> dict[str, Any]:
    return service.get_chat(chat_id)


@router.patch("/assistant/chats/{chat_id}")
def rename(chat_id: str, body: Rename, service: AssistantService = Depends(assistant)) -> dict[str, Any]:
    return service.rename(chat_id, body.title)


@router.delete("/assistant/chats/{chat_id}", status_code=204)
def delete(chat_id: str, service: AssistantService = Depends(assistant)) -> Response:
    service.delete_chat(chat_id)
    return Response(status_code=204)


@router.get("/assistant/chats/{chat_id}/turns/{turn_id}/log")
def turn_log(chat_id: str, turn_id: str, service: AssistantService = Depends(assistant)) -> list[dict[str, Any]]:
    """Every event of a past turn, with the full output of each command."""
    return service.turn_log(chat_id, turn_id)


@router.post("/assistant/chats/{chat_id}/files", openapi_extra=limit(MAX_FILES * MAX_FILE_BYTES + FORM_OVERHEAD))
async def upload(chat_id: str, files: list[UploadFile] = File(...),
                 service: AssistantService = Depends(assistant)) -> list[dict[str, Any]]:
    """Puts files in the chat's inputs/ folder. Free: nothing is sent to a model until a message attaches them."""
    read = [(f.filename or "file", await f.read(MAX_FILE_BYTES + 1)) for f in files]
    # Writing and hashing up to 200 MB is blocking work: it runs in a worker thread, not on the event loop.
    return await run_in_threadpool(service.upload, chat_id, read)


@router.post("/assistant/chats/{chat_id}/send", dependencies=[Depends(require_budget)])
def send(chat_id: str, body: Send, service: AssistantService = Depends(assistant)) -> StreamingResponse:
    """One message: the agent plans, works in the sandbox and answers; every step is streamed as it happens."""
    return StreamingResponse(service.send(chat_id, body.text, body.attachments, body.model, body.effort,
                                          body.run_budget_usd, body.approve_plans, body.mcp_servers,
                                          body.deck_brand, body.auto), **NDJSON)


@router.post("/assistant/approve")
def approve(body: Approve, service: AssistantService = Depends(assistant)) -> dict[str, Any]:
    """Approves, edits or rejects the plan a turn is waiting on."""
    service.approve(body.run_id, body.approval_id, body.decision,
                    [s.model_dump() for s in body.steps] if body.steps is not None else None, body.note)
    return {"ok": True}


@router.post("/assistant/runs/{run_id}/stop", status_code=204)
def stop(run_id: str, service: AssistantService = Depends(assistant)) -> Response:
    """Stops a turn and every sub-agent in it; what was done so far is kept."""
    service.stop(run_id)
    return Response(status_code=204)


@router.post("/assistant/chats/{chat_id}/compact", dependencies=[Depends(require_budget)])
def compact(chat_id: str, service: AssistantService = Depends(assistant)) -> dict[str, Any]:
    """Summarises the older turns now (a model call), instead of waiting for the chat to grow past the threshold."""
    return service.compact_now(chat_id)


@router.get("/assistant/files/recent")
def recent_files(limit: int = 12, service: AssistantService = Depends(assistant)) -> list[dict[str, Any]]:
    """The newest files made across chats, for the start screen."""
    return service.recent_files(limit)


@router.get("/assistant/mcp")
def mcp_list(service: AssistantService = Depends(assistant)) -> list[dict[str, Any]]:
    """The MCP servers: never their tokens (token_set says whether one is stored)."""
    return service.mcp_list()


@router.post("/assistant/mcp")
def mcp_add(body: McpAdd, service: AssistantService = Depends(assistant)) -> dict[str, Any]:
    """Adds a server after connecting to it and listing its tools; a URL that is not allowed, or a server that cannot
    be listed, is refused with the reason."""
    return service.mcp_add(body.name, body.url, body.token, body.ask_before_call)


@router.patch("/assistant/mcp/{server_id}")
def mcp_update(server_id: str, body: McpPatch, service: AssistantService = Depends(assistant)) -> dict[str, Any]:
    return service.mcp_update(server_id, body.model_dump())


@router.delete("/assistant/mcp/{server_id}", status_code=204)
def mcp_delete(server_id: str, service: AssistantService = Depends(assistant)) -> Response:
    service.mcp_delete(server_id)
    return Response(status_code=204)


@router.post("/assistant/mcp/{server_id}/check")
def mcp_check(server_id: str, service: AssistantService = Depends(assistant)) -> dict[str, Any]:
    """Connects again and lists the tools, updating the status."""
    return service.mcp_check(server_id)


def _serve(path: Any, kind: str, inline: bool) -> FileResponse:
    disposition = "inline" if inline else "attachment"
    headers = {"Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(path.name)}",
               "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    # Made by a model in a sandbox: never allowed to run script or reach this origin, even when opened directly. A PDF
    # is the exception: Chrome will not show a PDF under a CSP sandbox, and its viewer keeps a PDF's script to itself.
    if kind != "application/pdf":
        headers["Content-Security-Policy"] = "sandbox"
    return FileResponse(path, media_type=kind, headers=headers)


@media.get("/assistant/media/{chat_id}/{file_id}")
def file(chat_id: str, file_id: str, service: AssistantService = Depends(assistant)) -> FileResponse:
    return _serve(*service.media(chat_id, file_id))


@media.get("/assistant/media/{chat_id}/{file_id}/preview/{n}")
def preview(chat_id: str, file_id: str, n: int, service: AssistantService = Depends(assistant)) -> FileResponse:
    return _serve(*service.media(chat_id, file_id, n))
