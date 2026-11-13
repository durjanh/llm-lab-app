"""Research team: a coordinator and specialised subagents answering from an invented corpus, streamed as NDJSON."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import Field

from ..schemas import ModelChoice
from ..services.research_team import ResearchTeamService
from .deps import require_budget, require_lab_page, research_team

router = APIRouter(dependencies=[Depends(require_lab_page)])


class TeamRun(ModelChoice):
    question: str = Field(min_length=3, max_length=500)
    budget_usd: float = Field(default=0.25, ge=0.02, le=1.0)
    stop_after: int | None = Field(default=None, ge=0, le=8)  # simulate a crash after this many subagents


class TeamResume(ModelChoice):
    run_id: str = Field(pattern=r"^[0-9a-f]{12}$")
    budget_usd: float = Field(default=0.25, ge=0.02, le=1.0)


@router.get("/research-team/info")
def info(service: ResearchTeamService = Depends(research_team)) -> dict[str, Any]:
    """The corpus, the subagent definitions, the tools and the example questions."""
    return service.info()


@router.get("/research-team/runs")
def runs(service: ResearchTeamService = Depends(research_team)) -> dict[str, Any]:
    """Runs with a manifest on disk, newest first."""
    return {"runs": service.runs()}


@router.post("/research-team/run", dependencies=[Depends(require_budget)])
def run(body: TeamRun, service: ResearchTeamService = Depends(research_team)) -> StreamingResponse:
    """One question through the whole team, every agent turn and tool call streamed as it happens."""
    return StreamingResponse(service.run(body.question, body.model, body.budget_usd, body.stop_after),
                             media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@router.post("/research-team/resume", dependencies=[Depends(require_budget)])
def resume(body: TeamResume, service: ResearchTeamService = Depends(research_team)) -> StreamingResponse:
    """Loads a run's manifest and continues only the unfinished work."""
    return StreamingResponse(service.run("", body.model, body.budget_usd, None, body.run_id),
                             media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
