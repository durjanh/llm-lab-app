"""The site builder: a turn streams like the other runs; the rest reads a site's files, screenshots and zip."""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse, Response, StreamingResponse

from ..core.errors import ApiError
from ..core.body_limit import FORM_OVERHEAD, LimitedRoute, limit
from ..schemas import SiteRenameRequest, SiteRestoreRequest, SiteTurnRequest
from ..services.site_uploads import MAX_FILES, MAX_PDF_BYTES
from ..services.sites import FileProblem, SiteService
from ..settings import MODELS
from .deps import require_budget, require_lab_page, site_service

router = APIRouter(dependencies=[Depends(require_lab_page)], route_class=LimitedRoute)
SHOT_NAME = re.compile(r"^[\w.-]+\.png$")


@router.post("/sites/turn", dependencies=[Depends(require_budget)])
def site_turn(body: SiteTurnRequest, service: SiteService = Depends(site_service)) -> StreamingResponse:
    lines = service.turn(body.site_id, body.prompt, body.model, body.attachments, body.effort)
    return StreamingResponse(lines, media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@router.get("/sites")
def site_list(service: SiteService = Depends(site_service)) -> dict[str, Any]:
    """The sites, whether screenshots work, and what each model can take: pictures, PDFs and effort levels."""
    return {"sites": service.store.list(), "screenshots": service.browser.available,
            "models": {m: service.capabilities(m) for m in MODELS}}


@router.post("/sites/uploads", openapi_extra=limit(MAX_FILES * MAX_PDF_BYTES + FORM_OVERHEAD))
async def site_uploads(files: list[UploadFile] = File(...), caller: str | None = Form(default=None),
                       service: SiteService = Depends(site_service)) -> list[dict[str, Any]]:
    """Files for a message that has not been sent yet, so a first message can carry them before its site exists.
    Free: nothing reaches a model until a message attaches them."""
    if len(files) > MAX_FILES:
        raise ApiError(400, "invalid_request", f"Attach at most {MAX_FILES} files at once.")
    read = [(f.filename or "file", await f.read(MAX_PDF_BYTES + 1)) for f in files]
    # Checking and shrinking pictures is blocking work. `caller` is the page's id for its tab, for a fair share.
    saved = await run_in_threadpool(service.uploads.save, read, caller)
    return [u.public() for u in saved]


@router.get("/sites/{site_id}")
def site_detail(site_id: str, service: SiteService = Depends(site_service)) -> dict[str, Any]:
    return service.detail(service.site(site_id))


@router.patch("/sites/{site_id}")
def site_rename(site_id: str, body: SiteRenameRequest, service: SiteService = Depends(site_service)) -> dict[str, Any]:
    return service.detail(service.rename(site_id, body.title))


@router.post("/sites/{site_id}/versions/{n}/restore")
def site_restore_version(site_id: str, n: int, service: SiteService = Depends(site_service)) -> dict[str, Any]:
    """The files as they were in version n, kept as a new version; nothing is lost."""
    return service.detail(service.restore_version(site_id, n))


@router.get("/sites/{site_id}/file")
def site_file(site_id: str, path: str, service: SiteService = Depends(site_service)) -> PlainTextResponse:
    try:
        return PlainTextResponse(service.site(site_id).files.read(path), headers={"Cache-Control": "no-store"})
    except FileProblem as problem:
        raise ApiError(404, "not_found", str(problem)) from problem


@router.get("/sites/{site_id}/shots/{name}")
def site_shot(site_id: str, name: str, service: SiteService = Depends(site_service)) -> Response:
    file = service.site(site_id).shots / name
    if not SHOT_NAME.match(name) or not file.is_file():
        raise ApiError(404, "not_found", "There is no screenshot with that name.")
    return Response(file.read_bytes(), media_type="image/png")


@router.get("/sites/{site_id}/zip")
def site_zip(site_id: str, service: SiteService = Depends(site_service)) -> Response:
    site = service.site(site_id)
    name = re.sub(r"[^\w-]+", "-", site.title.lower()).strip("-")[:40] or "site"
    return Response(site.files.zip(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{name}.zip"'})


@router.post("/sites/{site_id}/restore")
def site_restore(site_id: str, body: SiteRestoreRequest, service: SiteService = Depends(site_service)) -> dict[str, Any]:
    """Back to how the site was before one of its messages. The files it replaces are kept in backups/."""
    return service.detail(service.restore(site_id, body.keep))


@router.delete("/sites/{site_id}")
def site_delete(site_id: str, service: SiteService = Depends(site_service)) -> dict[str, Any]:
    if not service.store.delete(site_id):
        raise ApiError(404, "not_found", "There is no site with that id.")
    return {"ok": True}
