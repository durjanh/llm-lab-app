"""The /api routes. Each module is a thin layer over one service: parse the request, call it, shape the response."""
from fastapi import APIRouter

from . import agents, casework, decks, documents, mcp_lab, medassist, messages, sites, status, tutor

router = APIRouter(prefix="/api")
for module in (status, messages, agents, decks, sites, tutor, documents, mcp_lab, casework, medassist):
    router.include_router(module.router)
