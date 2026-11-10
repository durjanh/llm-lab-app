"""The shoplifting alert desk: a simulation with invented people. Thin routes over StoreWatchService."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import CameraAnalyse, CameraConsent, CameraDoor, ComplianceRequest, DoorRequest, MatchDecision, RemoveEntry, ReviewRequest
from ..services.storewatch import StoreWatchService
from .deps import require_budget, require_lab_page, storewatch

router = APIRouter(prefix="/storewatch", dependencies=[Depends(require_lab_page)])


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


@router.post("/camera/consent")
def camera_consent(body: CameraConsent, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.camera_consent(body.by)


@router.post("/camera/analyse", dependencies=[Depends(require_budget)])
def camera_analyse(body: CameraAnalyse, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.camera_analyse(body.frames, body.descriptor, body.thumbnail, body.layout)


@router.post("/camera/door")
def camera_door(body: CameraDoor, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.camera_door(body.descriptor, body.threshold)


@router.post("/advance/{days}")
def advance(days: int, service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.advance(max(0, min(days, 365)))


@router.post("/reset")
def reset(service: StoreWatchService = Depends(storewatch)) -> dict[str, Any]:
    return service.reset()
