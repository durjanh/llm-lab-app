"""The tutor's people: names, faces and voices, including people's own voices through Azure personal voice."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..services.tutor_people import TutorPeopleService
from .deps import require_lab_page, tutor_people

router = APIRouter(dependencies=[Depends(require_lab_page)])
# The avatar file goes to TalkingHead's loader, which cannot send the lab header; it serves only uploaded files.
media = APIRouter()

PersonId = Field(pattern=r"^[0-9a-f]{10}$")


class PersonIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    body: str = "F"
    avatar: str = "sonia"
    voice: str = "en-GB-SoniaNeural"
    locale: str = "en-GB"


class PersonChange(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=40)
    body: str | None = None
    avatar: str | None = None
    voice: str | None = None
    locale: str | None = None


@router.get("/tutor/people")
def people(service: TutorPeopleService = Depends(tutor_people)) -> dict[str, Any]:
    """Everyone, the voices to choose from, and whether personal voice can be used."""
    return service.list()


@router.post("/tutor/people")
def create(body: PersonIn, service: TutorPeopleService = Depends(tutor_people)) -> dict[str, Any]:
    return service.create(body.name, body.body, body.avatar, body.voice, body.locale)


@router.patch("/tutor/people/{person_id}")
def update(person_id: str, body: PersonChange, service: TutorPeopleService = Depends(tutor_people)) -> dict[str, Any]:
    return service.update(person_id, body.model_dump())


@router.delete("/tutor/people/{person_id}")
def delete(person_id: str, service: TutorPeopleService = Depends(tutor_people)) -> dict[str, Any]:
    return service.delete(person_id)


@router.post("/tutor/people/{person_id}/avatar")
async def upload_avatar(person_id: str, file: UploadFile = File(...),
                        service: TutorPeopleService = Depends(tutor_people)) -> dict[str, Any]:
    """A GLB with a humanoid rig and ARKit and Oculus mouth shapes, such as Avaturn exports."""
    return service.upload_avatar(person_id, await file.read())


@router.post("/tutor/people/{person_id}/voice")
async def start_voice(person_id: str, company: str = Form(..., max_length=80), consent: UploadFile = File(...),
                      sample: UploadFile = File(...), service: TutorPeopleService = Depends(tutor_people)) -> dict[str, Any]:
    """Starts cloning the person's own voice: their consent recording and a 5 to 90 second sample, as WAV."""
    return service.start_voice(person_id, company, await consent.read(), await sample.read())


@router.get("/tutor/people/{person_id}/voice")
def refresh_voice(person_id: str, service: TutorPeopleService = Depends(tutor_people)) -> dict[str, Any]:
    """Where Azure has got to with the person's voice, moving it on a step when it can."""
    return service.refresh_voice(person_id)


@router.delete("/tutor/people/{person_id}/voice")
def remove_voice(person_id: str, service: TutorPeopleService = Depends(tutor_people)) -> dict[str, Any]:
    return service.remove_voice(person_id)


@router.get("/tutor/personal-voice-token")
def token(service: TutorPeopleService = Depends(tutor_people)) -> dict[str, Any]:
    """A Speech token for the personal voice resource, for the browser to speak in people's own voices."""
    return service.token()


@media.get("/tutor/people/{person_id}/avatar.glb")
def avatar(person_id: str, service: TutorPeopleService = Depends(tutor_people)) -> FileResponse:
    if not (len(person_id) == 10 and all(c in "0123456789abcdef" for c in person_id)):
        from ..core.errors import ApiError

        raise ApiError(404, "not_found", "No such person.")
    return FileResponse(service.avatar_file(person_id), media_type="model/gltf-binary")
