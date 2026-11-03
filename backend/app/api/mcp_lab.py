"""The MCP lab: the example server's details, a reset, and Claude using its tools.

The server's own MCP endpoint is mounted at /api/mcp-lab/mcp in main.py; it checks its own bearer tokens.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import McpAskRequest
from ..services.mcp_lab import McpLab
from ..shared import DEFAULT_MODEL
from .deps import mcp_lab, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


@router.get("/mcp-lab/info")
def info(service: McpLab = Depends(mcp_lab)) -> dict[str, Any]:
    """The server's address and the demo tokens."""
    return service.info()


@router.post("/mcp-lab/reset")
def reset(service: McpLab = Depends(mcp_lab)) -> dict[str, Any]:
    return service.reset()


@router.post("/mcp-lab/ask", dependencies=[Depends(require_budget)])
def ask(body: McpAskRequest, service: McpLab = Depends(mcp_lab)) -> dict[str, Any]:
    return service.ask(body.task, body.model or DEFAULT_MODEL, body.allow_writes)
