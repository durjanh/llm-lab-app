"""Foundry operations: deployments, quotas, rate limits, metrics, security, evaluations and tracing (read only on Azure)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import TraceRequest
from ..services.foundryops import FoundryOpsService
from .deps import foundryops, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])
PAID = [Depends(require_budget)]


@router.get("/foundryops/info")
def info(service: FoundryOpsService = Depends(foundryops)) -> dict[str, Any]:
    return service.info()


@router.get("/foundryops/deployments")
def deployments(service: FoundryOpsService = Depends(foundryops)) -> dict[str, Any]:
    return service.deployments()


@router.get("/foundryops/quotas")
def quotas(service: FoundryOpsService = Depends(foundryops)) -> dict[str, Any]:
    return service.quotas()


@router.post("/foundryops/rate-limit", dependencies=PAID)
def rate_limit(service: FoundryOpsService = Depends(foundryops)) -> dict[str, Any]:
    return service.rate_limit()


@router.get("/foundryops/metrics")
def metrics(hours: int = 24, service: FoundryOpsService = Depends(foundryops)) -> dict[str, Any]:
    return service.metrics(max(1, min(hours, 168)))


@router.get("/foundryops/security")
def security(service: FoundryOpsService = Depends(foundryops)) -> dict[str, Any]:
    return service.security()


@router.post("/foundryops/evaluate", dependencies=PAID)
def evaluate(service: FoundryOpsService = Depends(foundryops)) -> dict[str, Any]:
    return service.evaluate()


@router.post("/foundryops/trace", dependencies=PAID)
def trace(body: TraceRequest, service: FoundryOpsService = Depends(foundryops)) -> dict[str, Any]:
    return service.trace(body.question)
