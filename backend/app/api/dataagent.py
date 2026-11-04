"""The data agent: Claude answers questions about a warehouse in a workbook, through a semantic model or in SQL.

Every route but the directory needs a signed-in viewer, and passes it to the service, which limits every query,
cache entry, workbook and dashboard to the viewer's company."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..schemas import DataAsk, DataQuery, DataSql
from ..services.data_model import Viewer
from ..services.dataagent import DataAgentService
from .deps import data_viewer, dataagent, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])
NDJSON = {"media_type": "application/x-ndjson", "headers": {"Cache-Control": "no-store"}}


@router.get("/dataagent/viewers")
def viewers(service: DataAgentService = Depends(dataagent)) -> dict[str, Any]:
    """The people the page can sign in as, each in one company. Stands in for a sign-in page."""
    return {"viewers": service.viewers()}


@router.get("/dataagent/model")
def model(service: DataAgentService = Depends(dataagent), viewer: Viewer = Depends(data_viewer)) -> dict[str, Any]:
    """The semantic model's topics and fields, the viewer's company's schema, and its saved dashboards."""
    return service.model(viewer)


@router.post("/dataagent/ask", dependencies=[Depends(require_budget)])
def ask(body: DataAsk, service: DataAgentService = Depends(dataagent),
        viewer: Viewer = Depends(data_viewer)) -> StreamingResponse:
    """The agent works on the question; each step, query, chart and tile is streamed as it happens."""
    return StreamingResponse(service.ask(body.question.strip(), body.session_id, body.model, viewer), **NDJSON)


@router.post("/dataagent/query")
def query(body: DataQuery, service: DataAgentService = Depends(dataagent),
          viewer: Viewer = Depends(data_viewer)) -> dict[str, Any]:
    """A query from the field picker. No model is involved, so it costs nothing."""
    return service.query(body.model_dump(), viewer)


@router.post("/dataagent/sql")
def sql(body: DataSql, service: DataAgentService = Depends(dataagent),
        viewer: Viewer = Depends(data_viewer)) -> dict[str, Any]:
    """SQL from the SQL tab, run read-only with the agent's checks. No model is involved, so it costs nothing."""
    return service.query(body.model_dump(), viewer)


@router.get("/dataagent/dashboards/{name}")
def dashboard(name: str, service: DataAgentService = Depends(dataagent),
              viewer: Viewer = Depends(data_viewer)) -> dict[str, Any]:
    return {"name": name, "tiles": service.tile_data(name, viewer)}


@router.delete("/dataagent/dashboards/{name}")
def delete_dashboard(name: str, service: DataAgentService = Depends(dataagent),
                     viewer: Viewer = Depends(data_viewer)) -> dict[str, Any]:
    return {"dashboards": service.delete_dashboard(name, viewer)}


@router.post("/dataagent/reset")
def reset(service: DataAgentService = Depends(dataagent)) -> dict[str, Any]:
    return service.reset()
