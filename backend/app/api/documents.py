"""Document automation: templates, filling the interview from documents, assembly and review."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import Response
from pydantic import ValidationError

from ..core.errors import ApiError
from ..schemas import AssembleRequest, DocumentChatRequest, DocumentModelChoice
from ..services.documents import DOCX, MAX_FILE_BYTES, DocumentService
from .deps import document_service, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


async def read(upload: UploadFile) -> tuple[str, bytes]:
    return upload.filename or "file", await upload.read(MAX_FILE_BYTES + 1)


def checked_model(model: str | None) -> str | None:
    """Claude or a GPT deployment: the document service checks the name against what is available."""
    if model and len(model) > 64:
        raise ApiError(400, "invalid_request", "model: too long")
    return model or None


@router.get("/documents/samples/{name}")
def sample(name: str, service: DocumentService = Depends(document_service)) -> Response:
    media_type, content = service.sample(name)
    return Response(content, media_type=media_type, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/documents/templates", dependencies=[Depends(require_budget)])
async def add_template(file: UploadFile = File(...), mode: str = Form("template"), model: str | None = Form(None),
                       service: DocumentService = Depends(document_service)) -> dict[str, Any]:
    """mode=template: a Word file that already has {{ fields }}. mode=author: a finished document for AI to turn into one."""
    name, content = await read(file)
    if mode == "author":
        return service.author(name, content, checked_model(model))
    return service.add_template(name, content, checked_model(model))


@router.get("/documents/templates/{template_id}/file")
def template_file(template_id: str, service: DocumentService = Depends(document_service)) -> Response:
    template = service.template(template_id)
    return Response(template.content, media_type=DOCX, headers={"Content-Disposition": f'attachment; filename="{template.name}"'})


@router.post("/documents/templates/{template_id}/extract", dependencies=[Depends(require_budget)])
async def extract(template_id: str, files: list[UploadFile] = File(default=[]), note: str = Form(""),
                  model: str | None = Form(None), service: DocumentService = Depends(document_service)) -> dict[str, Any]:
    if len(files) > 5:
        raise ApiError(400, "invalid_request", "Add at most five source documents.")
    sources = [await read(f) for f in files]
    return service.extract(template_id, sources, note[:60_000], checked_model(model))


@router.post("/documents/templates/{template_id}/chat", dependencies=[Depends(require_budget)])
async def chat(template_id: str, message: str = Form(""), answers: str = Form("{}"), history: str = Form("[]"),
               model: str | None = Form(None), files: list[UploadFile] = File(default=[]),
               service: DocumentService = Depends(document_service)) -> dict[str, Any]:
    """Fill the interview: one message, typed, spoken or pasted, with documents attached if any. A form,
    so files can come with it; the answers so far and the conversation come as JSON fields."""
    try:
        state = DocumentChatRequest.model_validate({"message": message or " ", "answers": json.loads(answers),
                                                    "history": json.loads(history), "model": model or None})
    except (ValueError, ValidationError) as exc:
        raise ApiError(400, "invalid_request", f"The message could not be read: {exc}") from exc
    if not message.strip() and not files:
        raise ApiError(400, "invalid_request", "Write, say or attach something first.")
    if len(files) > 5:
        raise ApiError(400, "invalid_request", "Attach at most five documents.")
    sources = [await read(f) for f in files]
    return service.chat(template_id, message[:4000], state.answers, [line.model_dump() for line in state.history],
                        state.model, sources)


@router.post("/documents/templates/{template_id}/preview")
def preview(template_id: str, body: AssembleRequest, service: DocumentService = Depends(document_service)) -> dict[str, Any]:
    """The document as the answers stand, with answered and empty fields marked. No AI."""
    return service.preview(template_id, body.answers)


@router.post("/documents/templates/{template_id}/assemble")
def assemble(template_id: str, body: AssembleRequest, service: DocumentService = Depends(document_service)) -> dict[str, Any]:
    return service.assemble(template_id, body.answers)


@router.get("/documents/assembled/{document_id}")
def assembled(document_id: str, service: DocumentService = Depends(document_service)) -> Response:
    made = service.document(document_id)
    return Response(made.content, media_type=DOCX, headers={"Content-Disposition": f'attachment; filename="{made.name}"'})


@router.post("/documents/assembled/{document_id}/review", dependencies=[Depends(require_budget)])
def review(document_id: str, body: DocumentModelChoice, service: DocumentService = Depends(document_service)) -> dict[str, Any]:
    return service.review(document_id, body.model)
