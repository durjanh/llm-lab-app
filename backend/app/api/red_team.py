"""Adversarial testing: an automated red team against the lab's own invented support agent, with defences to toggle and
regression suites to replay. Runs are paid and guarded; the estimate and the suites cost nothing."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from ..services.red_team import DEFENCE_KEYS, MAX_RUN_BUDGET, STRATEGY_KEYS, RedTeamService
from ..settings import MODELS
from ..shared import CLAUDE_MODEL, DEFAULT_MODEL
from .deps import red_team, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


class RedTeamRun(BaseModel):
    strategies: list[str] = Field(default_factory=lambda: list(STRATEGY_KEYS), max_length=len(STRATEGY_KEYS))
    per_strategy: int = Field(default=1, ge=0, le=5)
    seeds: bool = True
    defences: dict[str, bool] = Field(default_factory=dict)
    target_model: str = DEFAULT_MODEL
    attacker_model: str = CLAUDE_MODEL
    judge_model: str = DEFAULT_MODEL
    judge: bool = True
    budget_usd: float = Field(default=0.5, gt=0, le=MAX_RUN_BUDGET)
    suite_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{12}$")

    @field_validator("strategies")
    @classmethod
    def known_strategies(cls, value: list[str]) -> list[str]:
        unknown = [s for s in value if s not in STRATEGY_KEYS]
        if unknown:
            raise ValueError(f"Unknown strategies: {', '.join(unknown)}")
        return value

    @field_validator("defences")
    @classmethod
    def known_defences(cls, value: dict[str, bool]) -> dict[str, bool]:
        unknown = [k for k in value if k not in DEFENCE_KEYS]
        if unknown:
            raise ValueError(f"Unknown defences: {', '.join(unknown)}")
        return value

    @field_validator("target_model", "attacker_model", "judge_model")
    @classmethod
    def known_model(cls, value: str) -> str:
        if value not in MODELS:
            raise ValueError(f"Model must be one of: {', '.join(MODELS)}")
        return value


class SuiteSave(BaseModel):
    run_id: str = Field(pattern=r"^[0-9a-f]{12}$")
    name: str = Field(min_length=1, max_length=80)


@router.get("/red-team/info")
def info(service: RedTeamService = Depends(red_team)) -> dict[str, Any]:
    """The invented target, the strategies, the defences and the judge's rubric."""
    return service.info()


@router.post("/red-team/estimate")
def estimate(body: RedTeamRun, service: RedTeamService = Depends(red_team)) -> dict[str, Any]:
    """A rough cost for the run before it starts. Free."""
    return service.estimate(body.model_dump())


@router.post("/red-team/run", dependencies=[Depends(require_budget)])
def run(body: RedTeamRun, service: RedTeamService = Depends(red_team)) -> StreamingResponse:
    """Writes the attacks, plays each against the target and scores it, streamed as NDJSON."""
    return StreamingResponse(service.run(body.model_dump()), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


@router.get("/red-team/suites")
def suites(service: RedTeamService = Depends(red_team)) -> list[dict[str, Any]]:
    return service.suites()


@router.post("/red-team/suites")
def save_suite(body: SuiteSave, service: RedTeamService = Depends(red_team)) -> dict[str, Any]:
    """Keeps a run's attacks and verdicts, to replay after the defences change."""
    return service.save_suite(body.run_id, body.name.strip())


@router.delete("/red-team/suites/{suite_id}")
def delete_suite(suite_id: str, service: RedTeamService = Depends(red_team)) -> dict[str, Any]:
    service.delete_suite(suite_id)
    return {"deleted": suite_id}
