"""The voice agent: conversations, the page's live input, an event stream back, a normaliser and a read-aloud test."""
from __future__ import annotations

import asyncio
import json
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..core.errors import ApiError
from ..core.body_limit import FORM_OVERHEAD, LimitedRoute, limit
from ..services.voice_agent import (MAX_AUDIO_BYTES, MAX_PLAYED_MS, MAX_SPEAK, MAX_TEXT, VoiceAgentService,
                                    normalise_report)
from .deps import require_budget, require_lab_page, voice_agent

router = APIRouter(dependencies=[Depends(require_lab_page)], route_class=LimitedRoute)
Cid = Annotated[str, Path(pattern=r"^[0-9a-f]{12}$")]
NDJSON = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}


class Settings(BaseModel):
    """Every field optional: leave one out (or null) to keep the current value."""
    end_silence_ms: int | None = Field(default=None, ge=200, le=3000)
    eager_threshold: float | None = Field(default=None, ge=0.3, le=0.95)
    expressiveness: int | None = Field(default=None, ge=0, le=3)
    voice: str | None = Field(default=None, max_length=60)
    local_voice: str | None = Field(default=None, max_length=30)
    tts: Literal["azure", "local"] | None = None
    model: str | None = Field(default=None, max_length=80)


class SpeechStart(BaseModel):
    type: Literal["speech_start"]


class SpeechEnd(BaseModel):
    type: Literal["speech_end"]


class Partial(BaseModel):
    type: Literal["partial"]
    text: str = Field(min_length=1, max_length=MAX_TEXT)


class Final(BaseModel):
    type: Literal["final"]
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    audio_ms: float = Field(default=0, ge=0, le=120_000)  # the audio this sentence came from, for the speech cost


class Interrupt(BaseModel):
    type: Literal["interrupt"]
    reply_id: str = Field(pattern=r"^r\d{1,6}$")
    played_ms: float = Field(ge=0, le=MAX_PLAYED_MS)


class Playback(BaseModel):
    type: Literal["playback"]
    reply_id: str = Field(pattern=r"^r\d{1,6}$")
    state: Literal["started", "done"]


Input = Annotated[SpeechStart | SpeechEnd | Partial | Final | Interrupt | Playback, Field(discriminator="type")]


class TextTurn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT)


class Normalise(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_SPEAK * 2)


class Speak(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_SPEAK)
    tts: Literal["azure", "local"] = "azure"
    voice: str | None = Field(default=None, max_length=60)
    local_voice: str | None = Field(default=None, max_length=30)
    expressiveness: int = Field(default=2, ge=0, le=3)
    tag: str = Field(default="neutral", max_length=20)


@router.get("/voice-agent/info")
def info(service: VoiceAgentService = Depends(voice_agent)) -> dict[str, Any]:
    """Voices, styles, models, limits, what is set up. Free."""
    return service.info()


@router.post("/voice-agent/normalise")
def normalise(body: Normalise) -> dict[str, Any]:
    """Text as it will be spoken, with what changed marked. Free: nothing is synthesised."""
    return normalise_report(body.text)


@router.post("/voice-agent/speak", dependencies=[Depends(require_budget)])
def speak(body: Speak, service: VoiceAgentService = Depends(voice_agent)) -> dict[str, Any]:
    """The read-aloud test: normalised text, synthesised, as a base64 WAV."""
    return service.speak(body.text, body.tts, body.voice, body.local_voice, body.expressiveness, body.tag)


@router.post("/voice-agent/conversations")
def create(body: Settings | None = None, service: VoiceAgentService = Depends(voice_agent)) -> dict[str, Any]:
    return service.create(body.model_dump() if body else {})


@router.get("/voice-agent/conversations/{cid}")
def get(cid: Cid, service: VoiceAgentService = Depends(voice_agent)) -> dict[str, Any]:
    """The history (with what was heard and not heard after each interruption) and the latency summary."""
    return service.get(cid)


@router.patch("/voice-agent/conversations/{cid}/settings")
def update_settings(body: Settings, cid: Cid, service: VoiceAgentService = Depends(voice_agent)) -> dict[str, Any]:
    return service.update_settings(cid, body.model_dump())


@router.delete("/voice-agent/conversations/{cid}")
def close(cid: Cid, service: VoiceAgentService = Depends(voice_agent)) -> dict[str, Any]:
    """Stops any reply in flight and forgets the conversation."""
    service.close(cid)
    return {"ok": True}


@router.post("/voice-agent/conversations/{cid}/input", dependencies=[Depends(require_budget)])
def send_input(body: Input, cid: Cid, service: VoiceAgentService = Depends(voice_agent)) -> dict[str, Any]:
    """One thing from the page: speech started or ended, partial or final text, an interruption, a playback report."""
    return service.handle(cid, body.model_dump())


@router.post("/voice-agent/conversations/{cid}/text", dependencies=[Depends(require_budget)])
def text_turn(body: TextTurn, cid: Cid, service: VoiceAgentService = Depends(voice_agent)) -> dict[str, Any]:
    """A typed turn, ended at once."""
    return service.text_turn(cid, body.text)


@router.post("/voice-agent/conversations/{cid}/audio", dependencies=[Depends(require_budget)],
             openapi_extra=limit(MAX_AUDIO_BYTES + FORM_OVERHEAD))
async def audio_turn(file: UploadFile, cid: Cid, service: VoiceAgentService = Depends(voice_agent)) -> dict[str, Any]:
    """A recorded turn: a mono 16-bit WAV, transcribed by Azure, then handled as a finished turn."""
    data = await file.read(service.info()["limits"]["audio_bytes"] + 1)
    return await asyncio.to_thread(service.audio_turn, cid, data)


async def next_event(service: VoiceAgentService, session: Any, timeout: float) -> dict[str, Any] | None:
    """The next event, or None after `timeout` seconds. It waits on the event loop, woken by the thread that emits, so an
    open stream holds no worker thread (a thread each would fill the pool that audio uploads also need). An event is only
    taken off the queue without awaiting, so a cancelled wait (the page went) never takes one and loses it."""
    event = service.next_event(session)
    if event is not None:
        return event
    loop = asyncio.get_running_loop()
    ready = asyncio.Event()

    def wake() -> None:
        loop.call_soon_threadsafe(ready.set)

    service.watch(session, wake)
    try:
        event = service.next_event(session)  # emitted between the first look and watching
        if event is not None:
            return event
        try:
            await asyncio.wait_for(ready.wait(), timeout)
        except asyncio.TimeoutError:
            return None
        return service.next_event(session)
    finally:
        service.unwatch(session, wake)


@router.post("/voice-agent/conversations/{cid}/events")
async def events(request: Request, cid: Cid, service: VoiceAgentService = Depends(voice_agent)) -> StreamingResponse:
    """The conversation's events as NDJSON, until it is closed or the page goes. One listener at a time."""
    session = service.claim(cid)
    token = session.listener_token
    heartbeat = service.heartbeat_s

    async def stream():
        idle = 0.0
        sending: dict[str, Any] | None = None  # an event handed to the client but not yet confirmed sent
        try:
            while not await request.is_disconnected():
                event = await next_event(service, session, 0.5)
                if event is None:
                    idle += 0.5
                    if idle >= heartbeat:
                        idle = 0.0
                        yield b"\n"
                    continue
                idle = 0.0
                sending = event
                yield (json.dumps(event) + "\n").encode()
                sending = None
                if event.get("type") == "closed":
                    return
        finally:
            if sending is not None:  # the page went while this one was being sent: keep it for the next listener
                service.unread(session, sending)
            service.release(session, token)

    return StreamingResponse(stream(), media_type="application/x-ndjson", headers=NDJSON)
