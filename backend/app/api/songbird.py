"""The songbird page: the synth runs in the browser; only composing a song with a model is a paid call."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import Field

from ..schemas import ModelChoice
from ..services.songbird import SongbirdService
from .deps import require_budget, require_lab_page, songbird

router = APIRouter(dependencies=[Depends(require_lab_page)])


class SongCompose(ModelChoice):
    description: str = Field(min_length=3, max_length=600)


@router.post("/songbird/compose", dependencies=[Depends(require_budget)])
def compose(body: SongCompose, service: SongbirdService = Depends(songbird)) -> dict[str, Any]:
    """A score for the two-voice synth, written by a model and checked by code."""
    return service.compose(body.description.strip(), body.model)
