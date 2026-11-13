"""Structured extraction: schemas, tool_choice, validation and retry, few-shot, batches, review routing and a model
comparison, on an invented labelled document set. Everything that calls a model is paid and guarded."""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from ..core.errors import ApiError
from ..services.extraction import ExtractionService, FIRST_PASS_TOKENS
from ..services.extraction_docs import BY_ID
from ..settings import CLAUDE_MODELS
from ..shared import CLAUDE_MODEL
from .deps import extraction, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])

DOC_ID = r"^(inv|rec|po)-\d\d$"


class ClaudeChoice(BaseModel):
    """Batches and tool_choice are Claude features, so only Claude models are accepted here."""
    model: str = CLAUDE_MODEL

    @field_validator("model")
    @classmethod
    def claude_only(cls, value: str) -> str:
        if value not in CLAUDE_MODELS:
            raise ValueError(f"Model must be one of: {', '.join(CLAUDE_MODELS)}")
        return value


class DocDemo(ClaudeChoice):
    doc_id: str = Field(pattern=DOC_ID)


class ValidateDemo(DocDemo):
    simulate_format_errors: bool = False


class RunBody(ClaudeChoice):
    few_shot: bool = False
    doc_ids: list[str] | None = Field(default=None, max_length=24)
    budget_usd: float = Field(default=0.5, gt=0, le=2.0)

    @field_validator("doc_ids")
    @classmethod
    def known_docs(cls, value: list[str] | None) -> list[str] | None:
        bad = [d for d in value or [] if d not in BY_ID]
        if bad:
            raise ValueError(f"Unknown documents: {', '.join(bad)}")
        return value


class EstimateBody(ClaudeChoice):
    few_shot: bool = False
    doc_ids: list[str] | None = Field(default=None, max_length=24)

    @field_validator("doc_ids")
    @classmethod
    def known_docs(cls, value: list[str] | None) -> list[str] | None:
        return RunBody.known_docs(value)


class BatchSubmit(ClaudeChoice):
    doc_ids: list[str] | None = Field(default=None, max_length=24)
    max_tokens: int = Field(default=FIRST_PASS_TOKENS, ge=300, le=4000)


class ConfidenceBody(BaseModel):
    run_id: str = Field(pattern=r"^[0-9a-f]{12}$")
    target: float = Field(default=0.95, ge=0.5, le=1.0)
    seed: int = Field(default=7, ge=0, le=1_000_000)
    per_stratum: int = Field(default=2, ge=1, le=10)


class CompareBody(BaseModel):
    run_a: str = Field(pattern=r"^[0-9a-f]{12}$")
    run_b: str = Field(pattern=r"^[0-9a-f]{12}$")


BATCH_ID = r"^msgbatch_[A-Za-z0-9_]{1,64}$"


@router.get("/extraction/info")
def info(service: ExtractionService = Depends(extraction)) -> dict[str, Any]:
    """The document set with its ground truth, the schemas and the prices. Free."""
    return service.info()


@router.post("/extraction/estimate")
def estimate(body: EstimateBody, service: ExtractionService = Depends(extraction)) -> dict[str, Any]:
    return service.estimate(body.model, body.few_shot, body.doc_ids)


@router.post("/extraction/schema", dependencies=[Depends(require_budget)])
def schema(body: DocDemo, service: ExtractionService = Depends(extraction)) -> dict[str, Any]:
    """The same document through a required, non-nullable schema and a nullable one."""
    return service.schema_demo(body.doc_id, body.model)


@router.post("/extraction/tool-choice", dependencies=[Depends(require_budget)])
def tool_choice(body: DocDemo, service: ExtractionService = Depends(extraction)) -> dict[str, Any]:
    """auto, any and a forced tool on one document, with the raw responses."""
    return service.tool_choice_demo(body.doc_id, body.model)


@router.post("/extraction/validate", dependencies=[Depends(require_budget)])
def validate(body: ValidateDemo, service: ExtractionService = Depends(extraction)) -> dict[str, Any]:
    """Extract, check, retry with the errors, and stop when retrying cannot help."""
    return service.validate_demo(body.doc_id, body.model, body.simulate_format_errors)


@router.post("/extraction/run", dependencies=[Depends(require_budget)])
def run(body: RunBody, service: ExtractionService = Depends(extraction)) -> StreamingResponse:
    """Extracts every document in the set (or a chosen few), streamed as NDJSON."""
    return StreamingResponse(service.run(body.model_dump()), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


@router.post("/extraction/confidence")
def confidence(body: ConfidenceBody, service: ExtractionService = Depends(extraction)) -> dict[str, Any]:
    """Calibration, a review threshold and a stratified spot-check sample from a finished run. Free."""
    return service.confidence(body.run_id, body.target, body.seed, body.per_stratum)


@router.post("/extraction/compare")
def compare(body: CompareBody, service: ExtractionService = Depends(extraction)) -> dict[str, Any]:
    """Two finished runs side by side. Free."""
    return service.compare(body.run_a, body.run_b)


@router.post("/extraction/batch", dependencies=[Depends(require_budget)])
def batch_submit(body: BatchSubmit, service: ExtractionService = Depends(extraction)) -> dict[str, Any]:
    return service.batch_submit(body.model, body.doc_ids, body.max_tokens)


@router.get("/extraction/batch/{batch_id}")  # no budget check: collecting a batch already paid for must still work
def batch_poll(batch_id: str, service: ExtractionService = Depends(extraction)) -> dict[str, Any]:
    """The batch's status; once it has ended, the results matched by custom_id and scored."""
    _check(batch_id)
    return service.batch_poll(batch_id)


@router.post("/extraction/batch/{batch_id}/resubmit", dependencies=[Depends(require_budget)])
def batch_resubmit(batch_id: str, service: ExtractionService = Depends(extraction)) -> dict[str, Any]:
    """Sends only the failures again: oversized documents in chunks, the rest unchanged."""
    _check(batch_id)
    return service.batch_resubmit(batch_id)


def _check(batch_id: str) -> None:
    if not re.fullmatch(BATCH_ID, batch_id):
        raise ApiError(400, "invalid_request", "That is not a batch id.")
