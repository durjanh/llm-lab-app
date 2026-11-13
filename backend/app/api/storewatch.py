"""The shoplifting alert desk: the live camera desk and the scripted day. Thin routes over StoreWatchService."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse

from ..schemas import CameraAnalyse, CameraDoor, ComplianceRequest, DoorRequest, MatchDecision, RemoveEntry, ReviewRequest
from ..services.storewatch import StoreWatchService
from .deps import require_budget, require_lab_page, storewatch

router = APIRouter(prefix="/storewatch", dependencies=[Depends(require_lab_page)])
media = APIRouter()  # <video> tags cannot send the lab header; these clips are already made


@router.get("/state")
def state(service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.state()


@router.post("/compliance")
def compliance(body: ComplianceRequest, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.set_compliance(body.controller, body.lawful_basis, body.dpia_reference, body.signage)


@router.post("/alerts/next")
def next_alert(service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.next_alert()


@router.post("/alerts/{alert_id}/review")
def review(alert_id: int, body: ReviewRequest, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.review(alert_id, body.reviewer, body.theft, body.note, body.watched_footage)


@router.post("/door/next")
def door(body: DoorRequest, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.next_visitor(body.threshold)


@router.post("/matches/{match_id}/decide")
def decide(match_id: int, body: MatchDecision, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.decide_match(match_id, body.staff, body.same_person)


@router.post("/watchlist/{entry_id}/remove")
def remove(entry_id: int, body: RemoveEntry, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.remove(entry_id, body.by, body.reason)


@router.post("/camera/analyse", dependencies=[Depends(require_budget)])
def camera_analyse(body: CameraAnalyse, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.camera_analyse(body.frames, body.descriptor, body.thumbnail, body.layout, body.events, body.rules,
                                  body.track, body.use_model)


@router.post("/alerts/{alert_id}/clip")
def attach_clip(alert_id: int, file: UploadFile = File(...), start_s: float = Form(0.0),
                service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    """The evidence clip recorded around an alert."""
    return service.attach_clip(alert_id, file.file.read(12 * 2**20 + 1), start_s)


@media.get("/storewatch/media/clips/{name}")
def clip(name: str, service: StoreWatchService = Depends(storewatch)) -> FileResponse:
    path, media_type = service.clip_file(name)
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "no-store"})


@router.post("/camera/door")
def camera_door(body: CameraDoor, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.camera_door(body.descriptor, body.threshold)


@router.post("/advance/{days}")
def advance(days: int, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.advance(max(0, min(days, 365)))


@router.post("/reset")
def reset(service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.reset()
