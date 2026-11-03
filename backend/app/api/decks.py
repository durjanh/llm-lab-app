"""The deck builder. A turn is a multipart form, so files can come with the request; it streams like the other runs."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import StreamingResponse

from ..core.errors import ApiError
from ..services.decks import MAX_FILE_BYTES, DeckService, Upload
from ..settings import MODELS
from .deps import deck_service, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


async def read(upload: UploadFile) -> Upload:
    """Reads one uploaded file, stopping just past the size limit so a huge file is not held in memory."""
    content = await upload.read(MAX_FILE_BYTES + 1)
    return Upload(upload.filename or "file", content)


@router.post("/decks/turn", dependencies=[Depends(require_budget)])
async def deck_turn(prompt: str = Form(...), chat_id: str | None = Form(None), model: str | None = Form(None),
                    files: list[UploadFile] = File(default=[]), template: UploadFile | None = File(None),
                    service: DeckService = Depends(deck_service)) -> StreamingResponse:
    if model and model not in MODELS:
        raise ApiError(400, "invalid_request", f"model: Model must be one of: {', '.join(MODELS)}")
    sources = [await read(f) for f in files]
    lines = service.turn(chat_id or None, prompt, model, sources, await read(template) if template else None)
    return StreamingResponse(lines, media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@router.delete("/decks/{chat_id}")
def deck_end(chat_id: str, service: DeckService = Depends(deck_service)) -> dict[str, Any]:
    """Ends a conversation and deletes the files you uploaded for it."""
    service.end(chat_id)
    return {"ok": True}
