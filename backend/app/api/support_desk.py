"""The support desk agent: a support resolution agent for an invented shop, with the loop, the gate, the hooks, the
error shapes, the tool descriptions, tool_choice, escalation, case facts and a scripted evaluation all visible."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..schemas import ModelChoice
from ..services.support_desk import EVAL_CASES, MAX_RUN_BUDGET, SupportDeskService
from .deps import require_budget, require_lab_page, support_desk

router = APIRouter(dependencies=[Depends(require_lab_page)])


class Switches(BaseModel):
    """Each switch turns one mechanism off, so the page can show what it was doing."""
    enforce_gate: bool = True
    hooks: bool = True
    trim: bool = True
    case_facts: bool = True
    vague_tools: bool = False
    dangerous_tool: bool = False


class SupportChat(ModelChoice, Switches):
    case_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{12}$")
    message: str = Field(min_length=1, max_length=1500)


class SupportEvaluate(ModelChoice, Switches):
    cases: list[str] | None = Field(default=None, max_length=len(EVAL_CASES))
    budget_usd: float = Field(default=0.5, gt=0, le=MAX_RUN_BUDGET)


class ToolSelection(ModelChoice):
    vague_tools: bool = False
    dangerous_tool: bool = False


class ToolChoiceRun(ModelChoice):
    message: str | None = Field(default=None, min_length=1, max_length=600)


@router.get("/support-desk/info")
def info(service: SupportDeskService = Depends(support_desk)) -> dict[str, Any]:
    """The invented shop, its customers, the tool sets, the test set and the context demo. Free."""
    return service.info()


@router.post("/support-desk/chat", dependencies=[Depends(require_budget)])
def chat(body: SupportChat, service: SupportDeskService = Depends(support_desk)) -> dict[str, Any]:
    """One customer message through the agent loop, with the full trace."""
    return service.chat(body.model_dump())


@router.post("/support-desk/tool-selection", dependencies=[Depends(require_budget)])
def tool_selection(body: ToolSelection, service: SupportDeskService = Depends(support_desk)) -> dict[str, Any]:
    """Six fixed requests: which tool does the model call first with this tool set?"""
    return service.tool_selection(body.model_dump())


@router.post("/support-desk/tool-choice", dependencies=[Depends(require_budget)])
def tool_choice(body: ToolChoiceRun, service: SupportDeskService = Depends(support_desk)) -> dict[str, Any]:
    """The same request with tool_choice auto, any and forced."""
    return service.tool_choice(body.model_dump())


@router.post("/support-desk/evaluate", dependencies=[Depends(require_budget)])
def evaluate(body: SupportEvaluate, service: SupportDeskService = Depends(support_desk)) -> StreamingResponse:
    """Runs the scripted customer messages and scores each against its expected outcome, streamed as NDJSON."""
    return StreamingResponse(service.evaluate(body.model_dump()), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})
