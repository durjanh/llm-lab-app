"""Video translation: upload a video, then get it transcribed and translated as subtitles or as speech."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from ..services.video_translate import VideoTranslateService
from .deps import require_budget, require_lab_page, video_translate

router = APIRouter(dependencies=[Depends(require_lab_page)])
media = APIRouter()  # <video> and <audio> tags cannot send the lab header; these files are already made


class TranslateRequest(BaseModel):
    language: str = Field(min_length=2, max_length=10)
    voice: bool = False  # also speak each phrase in the chosen language


@router.get("/video-translate/info")
def info(service: VideoTranslateService = Depends(video_translate)) -> dict[str, Any]:
    return service.info()


@router.post("/video-translate/uploads")
def upload(file: UploadFile = File(...), service: VideoTranslateService = Depends(video_translate)) -> dict[str, Any]:
    """Saves the video on this machine and checks its size and length. Nothing goes to Azure yet."""
    return service.upload(file.filename or "video", file.file)


@router.post("/video-translate/uploads/{vid}/translate", dependencies=[Depends(require_budget)])
def translate(vid: str, body: TranslateRequest,
              service: VideoTranslateService = Depends(video_translate)) -> StreamingResponse:
    """Transcribes (once), translates into the chosen language and, if asked, speaks it, streamed as NDJSON."""
    return StreamingResponse(service.translate_stream(vid, body.language, body.voice),
                             media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@media.get("/video-translate/media/{vid}/source")
def source(vid: str, service: VideoTranslateService = Depends(video_translate)) -> FileResponse:
    path, media_type = service.source(vid)
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "no-store"})


@media.get("/video-translate/media/{vid}/voice/{code}/{index}")
def voice(vid: str, code: str, index: int, service: VideoTranslateService = Depends(video_translate)) -> FileResponse:
    return FileResponse(service.voice_file(vid, code, index), media_type="audio/wav",
                        headers={"Cache-Control": "max-age=3600"})
