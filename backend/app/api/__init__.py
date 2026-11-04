"""The /api routes. Each module is a thin layer over one service: parse the request, call it, shape the response."""
from fastapi import APIRouter

from . import aftercare, agents, dataagent, foundryops, guardrails, imagegen, searchlab, translate, understanding, casework, decks, documents, mcp_lab, medassist, messages, reviews, sites, status, tutor

router = APIRouter(prefix="/api")
for module in (status, messages, agents, decks, sites, tutor, documents, mcp_lab, casework, medassist, reviews, aftercare, guardrails, understanding, imagegen, searchlab, translate, foundryops, dataagent):
    router.include_router(module.router)
router.include_router(guardrails.images)  # generated sample pictures, fetched by <img> tags without the lab header
router.include_router(understanding.media)  # sample files for <img>, <video> and <audio> tags
router.include_router(imagegen.media)  # generated images for <img> tags
