"""Monitoring: the model calls the backend has made, summed up and as traces. Reading it costs nothing."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends

from ..services.observability import ObservabilityService
from .deps import observability, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/observability")
def overview(scope: Literal["session", "all"] = "session",
             service: ObservabilityService = Depends(observability)) -> dict[str, Any]:
    """Totals, spend by area and model, latency percentiles, recent calls and traces. No model is called."""
    return service.overview(scope)


@router.delete("/observability")
def clear(service: ObservabilityService = Depends(observability)) -> dict[str, Any]:
    """Empties the call log. The spend counted against the budget stays."""
    return service.clear()
