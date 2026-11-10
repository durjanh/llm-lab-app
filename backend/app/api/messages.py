from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..schemas import MessagesRequest, TokenBreakdownRequest
from ..services.messages import MessagesService
from ..settings import MAX_TOKENS_NON_STREAMING, MAX_TOKENS_STREAMING
from .deps import messages_service, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.post("/count_tokens")
def count_tokens(body: MessagesRequest, service: MessagesService = Depends(messages_service)) -> dict[str, int]:
    return {"input_tokens": service.count_tokens(body.params(MAX_TOKENS_STREAMING))}


@router.post("/count_tokens/breakdown")
def count_breakdown(body: TokenBreakdownRequest, service: MessagesService = Depends(messages_service)) -> dict[str, Any]:
    """Where a prompt's tokens go, word by word. Counting is free, so this route needs no budget."""
    return service.breakdown(body.model, body.system, body.prompt)


@router.post("/messages", dependencies=[Depends(require_budget)])
def messages(body: MessagesRequest, service: MessagesService = Depends(messages_service)) -> dict[str, Any]:
    return service.send(body.params(MAX_TOKENS_NON_STREAMING))


@router.post("/stream", dependencies=[Depends(require_budget)])
def stream(body: MessagesRequest, service: MessagesService = Depends(messages_service)) -> StreamingResponse:
    """Newline-delimited JSON: {"type": "text"} lines, then one {"type": "done"} or {"type": "error"} line."""
    lines = (json.dumps(event) + "\n" for event in service.stream(body.params(MAX_TOKENS_STREAMING)))
    return StreamingResponse(lines, media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
