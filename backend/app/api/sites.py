"""The site builder: a turn streams like the other runs; the rest reads a site's files, screenshots and zip."""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse, Response, StreamingResponse

from ..core.errors import ApiError
from ..schemas import SiteRestoreRequest, SiteTurnRequest
from ..services.sites import FileProblem, SiteService
from .deps import require_budget, require_lab_page, site_service

router = APIRouter(dependencies=[Depends(require_lab_page)])
SHOT_NAME = re.compile(r"^[\w.-]+\.png$")


@router.post("/sites/turn", dependencies=[Depends(require_budget)])
def site_turn(body: SiteTurnRequest, service: SiteService = Depends(site_service)) -> StreamingResponse:
    lines = service.turn(body.site_id, body.prompt, body.model)
    return StreamingResponse(lines, media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@router.get("/sites")
def site_list(service: SiteService = Depends(site_service)) -> dict[str, Any]:
    return {"sites": service.store.list(), "screenshots": service.browser.available}


@router.get("/sites/{site_id}")
def site_detail(site_id: str, service: SiteService = Depends(site_service)) -> dict[str, Any]:
    site = service.site(site_id)
    return {"id": site.id, "title": site.title, "turns": site.turns, "files": site.files.listing()}


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
    site = service.restore(site_id, body.keep)
    return {"id": site.id, "title": site.title, "turns": site.turns, "files": site.files.listing()}


@router.delete("/sites/{site_id}")
def site_delete(site_id: str, service: SiteService = Depends(site_service)) -> dict[str, Any]:
    if not service.store.delete(site_id):
        raise ApiError(404, "not_found", "There is no site with that id.")
    return {"ok": True}
