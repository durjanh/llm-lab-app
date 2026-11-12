"""The diet planner: conversations, the checked plan as files, and the person's memory folder."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Response
from fastapi.responses import StreamingResponse

from ..schemas import DietMessage, DietStart
from ..services.diet import DietService
from .deps import diet, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/diet/info")
def info(service: DietService = Depends(diet)) -> dict[str, Any]:
    return service.info()


@router.post("/diet/chats")
def start(body: DietStart, service: DietService = Depends(diet)) -> dict[str, Any]:
    """A new conversation for one person. Nothing is sent to the model until they write."""
    return service.start(body.model, body.user, body.consent)


@router.post("/diet/chats/{chat_id}/messages", dependencies=[Depends(require_budget)])
def message(chat_id: str, body: DietMessage, service: DietService = Depends(diet)) -> dict[str, Any]:
    return service.message(chat_id, body.message.strip())


@router.post("/diet/chats/{chat_id}/stream", dependencies=[Depends(require_budget)])
def stream(chat_id: str, body: DietMessage, service: DietService = Depends(diet)) -> StreamingResponse:
    """The same turn, streamed as NDJSON so the page shows the planner working."""
    return StreamingResponse(service.stream_message(chat_id, body.message.strip()), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


@router.get("/diet/chats/{chat_id}/files/{kind}")
def file(chat_id: str, kind: str, service: DietService = Depends(diet)) -> Response:
    """The checked plan as a PDF, a shopping list PDF or an Excel workbook. Fetched by the page with the lab header."""
    content, name, media = service.file(chat_id, kind)
    return Response(content, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/diet/memory/{user}")
def memory(user: str, service: DietService = Depends(diet)) -> dict[str, Any]:
    return {"memory": service.memory(user)}


@router.delete("/diet/memory/{user}")
def forget(user: str, service: DietService = Depends(diet)) -> dict[str, Any]:
    return service.forget(user)
