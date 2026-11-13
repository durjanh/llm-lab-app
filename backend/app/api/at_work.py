"""Claude at work: the Associate-exam lab's live tools. The page's text and templates are static; these calls are paid."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import Field, field_validator

from ..core.errors import ApiError
from ..schemas import ModelChoice
from ..services.at_work import TASK_TYPES, AtWorkService, build_prompt
from .deps import at_work, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


class TaskRun(ModelChoice):
    goal: str = Field(min_length=3, max_length=1500)
    context: str = Field(default="", max_length=6000)
    task_types: list[str] = Field(min_length=1, max_length=2)

    @field_validator("task_types")
    @classmethod
    def known(cls, value: list[str]) -> list[str]:
        if any(t not in TASK_TYPES for t in value):
            raise ValueError(f"Task type must be one of: {', '.join(TASK_TYPES)}")
        return value


class Decompose(ModelChoice):
    request: str = Field(min_length=10, max_length=4000)


class Rewrite(ModelChoice):
    source: str = Field(min_length=10, max_length=8000)
    audiences: list[str] = Field(min_length=2, max_length=3)

    @field_validator("audiences")
    @classmethod
    def tidy(cls, value: list[str]) -> list[str]:
        cleaned = [a.strip() for a in value]
        if any(not 2 <= len(a) <= 80 for a in cleaned) or len({a.lower() for a in cleaned}) != len(cleaned):
            raise ValueError("Give two or three different audiences, each 2 to 80 characters.")
        return cleaned


class Check(ModelChoice):
    answer: str = Field(min_length=10, max_length=12000)
    source: str = Field(default="", max_length=20000)


class UseCase(ModelChoice):
    task: str = Field(min_length=10, max_length=3000)
    data: str = Field(default="", max_length=3000)


@router.get("/at-work/template")
def template(task_type: str, goal: str = "", context: str = "") -> dict[str, Any]:
    """The prompt template for a task type. Free: no model is called."""
    try:
        return build_prompt(task_type, goal or "[your goal]", context)
    except ValueError as exc:
        raise ApiError(400, "invalid_request", str(exc)) from exc


@router.post("/at-work/run", dependencies=[Depends(require_budget)])
def run(body: TaskRun, service: AtWorkService = Depends(at_work)) -> dict[str, Any]:
    """Run one goal under one or two task types."""
    return service.run_task(body.goal, body.context, body.task_types, body.model)


@router.post("/at-work/decompose", dependencies=[Depends(require_budget)])
def decompose(body: Decompose, service: AtWorkService = Depends(at_work)) -> dict[str, Any]:
    return service.decompose(body.request.strip(), body.model)


@router.post("/at-work/rewrite", dependencies=[Depends(require_budget)])
def rewrite(body: Rewrite, service: AtWorkService = Depends(at_work)) -> dict[str, Any]:
    return service.rewrite(body.source.strip(), body.audiences, body.model)


@router.post("/at-work/check", dependencies=[Depends(require_budget)])
def check(body: Check, service: AtWorkService = Depends(at_work)) -> dict[str, Any]:
    return service.check(body.answer.strip(), body.source.strip(), body.model)


@router.post("/at-work/use-case", dependencies=[Depends(require_budget)])
def use_case(body: UseCase, service: AtWorkService = Depends(at_work)) -> dict[str, Any]:
    return service.use_case(body.task.strip(), body.data.strip(), body.model)
