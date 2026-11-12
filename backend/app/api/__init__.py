"""The /api routes. Each module is a thin layer over one service: parse the request, call it, shape the response."""
from fastapi import APIRouter

from . import brain, diet, hotel, scans, whiteboard, token_counter, storewatch, workflows, aftercare, agents, coding, dataagent, foundryops, guardrails, imagegen, searchlab, translate, understanding, casework, decks, documents, mcp_lab, medassist, messages, reviews, sites, status, tutor

router = APIRouter(prefix="/api")
for module in (status, messages, agents, workflows, storewatch, decks, sites, tutor, documents, mcp_lab, casework, medassist, reviews, aftercare, hotel, diet, whiteboard, brain, scans, token_counter, guardrails, understanding, imagegen, searchlab, translate, foundryops, dataagent, coding):
    router.include_router(module.router)
from . import deals  # noqa: E402  (on its own line so parallel edits to the list above do not collide)
router.include_router(deals.router)
router.include_router(guardrails.images)  # generated sample pictures, fetched by <img> tags without the lab header
router.include_router(understanding.media)  # sample files for <img>, <video> and <audio> tags
router.include_router(imagegen.media)  # generated images for <img> tags
from . import local_embeddings  # noqa: E402  (its own line, so it does not collide with edits to the list above)
router.include_router(local_embeddings.router)  # embeddings from the open model on this machine
router.include_router(coding.downloads)  # what the coding agent made, for download links
router.include_router(aftercare.phone_events)  # a real call's events, from Communication Services
router.include_router(medassist.phone_events)  # the practice line: incoming calls and their events

from . import observability  # noqa: E402  (monitoring: the model calls made, summed up and as traces)

router.include_router(observability.router)
