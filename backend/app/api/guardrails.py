"""Guardrails: Azure AI Content Safety, Prompt Shields, groundedness and PII detection around a Foundry model."""
from __future__ import annotations

import base64
import binascii
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from ..core.errors import ApiError
from ..schemas import GuardEvaluate, GuardGrounded, GuardImage, GuardPipeline, GuardShield, GuardText
from ..services.guardrails import GuardrailsService
from .deps import guardrails, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])
images = APIRouter()  # an <img> cannot send the lab header; these pictures are drawn locally and cost nothing
PAID = [Depends(require_budget)]


@router.get("/guardrails/info")
def info(service: GuardrailsService = Depends(guardrails)) -> dict[str, Any]:
    return service.info()


@images.get("/guardrails/images/{image_id}")
def sample_image(image_id: str, service: GuardrailsService = Depends(guardrails)) -> Response:
    return Response(service.sample_image(image_id), media_type="image/png")


@router.post("/guardrails/moderate", dependencies=PAID)
def moderate(body: GuardText, service: GuardrailsService = Depends(guardrails)) -> dict[str, Any]:
    return service.moderate(body.text)


@router.post("/guardrails/shield", dependencies=PAID)
def shield(body: GuardShield, service: GuardrailsService = Depends(guardrails)) -> dict[str, Any]:
    return service.shield(body.prompt, [d for d in body.documents if d.strip()])


@router.post("/guardrails/groundedness", dependencies=PAID)
def groundedness(body: GuardGrounded, service: GuardrailsService = Depends(guardrails)) -> dict[str, Any]:
    return service.groundedness(body.answer, body.query, body.source) if body.source else service.groundedness(body.answer, body.query)


@router.post("/guardrails/protected", dependencies=PAID)
def protected(body: GuardText, service: GuardrailsService = Depends(guardrails)) -> dict[str, Any]:
    return service.protected(body.text)


@router.post("/guardrails/pii", dependencies=PAID)
def pii(body: GuardText, service: GuardrailsService = Depends(guardrails)) -> dict[str, Any]:
    return service.pii(body.text)


@router.post("/guardrails/image", dependencies=PAID)
def image(body: GuardImage, service: GuardrailsService = Depends(guardrails)) -> dict[str, Any]:
    if body.image_id:
        data = service.sample_image(body.image_id)
    else:
        try:
            data = base64.b64decode(body.data.split(",")[-1], validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ApiError(400, "invalid_request", "data: send the image as base64.") from exc
        if not data:
            raise ApiError(400, "invalid_request", "Send an image_id or the image data.")
    return service.image(data, body.question)


@router.post("/guardrails/pipeline", dependencies=PAID)
def pipeline(body: GuardPipeline, service: GuardrailsService = Depends(guardrails)) -> dict[str, Any]:
    return service.pipeline(body.question, body.document, body.threshold)


@router.post("/guardrails/evaluate", dependencies=PAID)
def evaluate(body: GuardEvaluate, service: GuardrailsService = Depends(guardrails)) -> dict[str, Any]:
    return service.evaluate(body.threshold)


@router.get("/guardrails/deployment")
def deployment(service: GuardrailsService = Depends(guardrails)) -> dict[str, Any]:
    """The content filter built into the model deployment, read from Resource Manager."""
    return service.deployment_filter()
