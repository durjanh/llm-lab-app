"""The AI whiteboard: read a sketch as a function or a solid, and answer questions about what the board shows."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import WhiteboardAsk, WhiteboardRead
from ..services.whiteboard import SHAPES, WhiteboardService
from .deps import require_budget, require_lab_page, whiteboard

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/whiteboard/info")
def info() -> dict[str, Any]:
    return {"shapes": SHAPES}


@router.post("/whiteboard/read", dependencies=[Depends(require_budget)])
def read(body: WhiteboardRead, service: WhiteboardService = Depends(whiteboard)) -> dict[str, Any]:
    """The sketch, as a function to plot or a solid to turn and cut, checked by code."""
    return service.read(body.image, body.prompt, body.model)


@router.post("/whiteboard/ask", dependencies=[Depends(require_budget)])
def ask(body: WhiteboardAsk, service: WhiteboardService = Depends(whiteboard)) -> dict[str, Any]:
    return service.ask(body.question.strip(), body.board, body.model)
