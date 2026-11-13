"""The AI whiteboard: read a sketch as a function or a solid, and answer questions about what the board shows."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import WhiteboardAsk, WhiteboardGuess, WhiteboardPicture, WhiteboardRead, WhiteboardScene
from ..services.whiteboard import WhiteboardService
from .deps import require_budget, require_lab_page, whiteboard

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/whiteboard/info")
def info(service: WhiteboardService = Depends(whiteboard)) -> dict[str, Any]:
    """The solids, the drawing game's words, and whether sketch to picture is set up."""
    return service.info()


@router.post("/whiteboard/read", dependencies=[Depends(require_budget)])
def read(body: WhiteboardRead, service: WhiteboardService = Depends(whiteboard)) -> dict[str, Any]:
    """The sketch, as a function to plot or a solid to turn and cut, checked by code."""
    return service.read(body.image, body.prompt, body.model)


@router.post("/whiteboard/ask", dependencies=[Depends(require_budget)])
def ask(body: WhiteboardAsk, service: WhiteboardService = Depends(whiteboard)) -> dict[str, Any]:
    return service.ask(body.question.strip(), body.board, body.model)


@router.post("/whiteboard/guess", dependencies=[Depends(require_budget)])
def guess(body: WhiteboardGuess, service: WhiteboardService = Depends(whiteboard)) -> dict[str, Any]:
    """The model's guesses at the sketch; code says whether one of them is the word."""
    return service.guess(body.image, body.word, body.model)


@router.post("/whiteboard/scene", dependencies=[Depends(require_budget)])
def scene(body: WhiteboardScene, service: WhiteboardService = Depends(whiteboard)) -> dict[str, Any]:
    """The sketch as balls, boxes and lines for the page's physics engine, checked by code."""
    return service.scene(body.image, body.hints, body.width, body.height, body.prompt, body.model)


@router.post("/whiteboard/picture", dependencies=[Depends(require_budget)])
def picture(body: WhiteboardPicture, service: WhiteboardService = Depends(whiteboard)) -> dict[str, Any]:
    """The sketch redrawn in a style by the image model."""
    return service.picture(body.image, body.style, body.subject)
