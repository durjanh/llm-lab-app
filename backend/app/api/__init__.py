"""The /api routes. Each module is a thin layer over one service: parse the request, call it, shape the response."""
from fastapi import APIRouter

from . import brain, diet, hotel, scans, whiteboard, token_counter, storewatch, workflows, aftercare, agents, coding, dataagent, foundryops, guardrails, imagegen, searchlab, translate, understanding, casework, decks, documents, mcp_lab, medassist, messages, reviews, sites, status, tutor

router = APIRouter(prefix="/api")
for module in (status, messages, agents, workflows, storewatch, decks, sites, tutor, documents, mcp_lab, casework, medassist, reviews, aftercare, hotel, diet, whiteboard, brain, scans, token_counter, guardrails, understanding, imagegen, searchlab, translate, foundryops, dataagent, coding):
    router.include_router(module.router)
from . import deals  # noqa: E402
router.include_router(deals.router)  # closed-deal agents
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

from . import code_graph  # noqa: E402  (the code knowledge graph)

router.include_router(code_graph.router)

from . import video_translate  # noqa: E402  (video translation: subtitles and speech in another language)

router.include_router(video_translate.router)
router.include_router(video_translate.media)  # the uploaded video and its spoken translation, for <video> and <audio>

from . import tabular  # noqa: E402  (tabular foundation models: TabPFN against gradient boosting)

router.include_router(tabular.router)

from . import vectordb  # noqa: E402  (PostgreSQL with pgvector, searched by meaning, by words and both)

router.include_router(vectordb.router)

from . import semantic_cache  # noqa: E402  (a semantic cache in front of a model, on pgvector)

router.include_router(semantic_cache.router)

from . import planning_patterns  # noqa: E402  (ReAct, plan-and-execute and reflexion, side by side)

router.include_router(planning_patterns.router)

from . import graphrag  # noqa: E402  (GraphRAG: a knowledge graph from a collection, local and global search)

router.include_router(graphrag.router)

from . import red_team  # noqa: E402  (adversarial testing: an automated red team against an invented agent)

router.include_router(red_team.router)

from . import lora  # noqa: E402  (fine-tuning with LoRA on this machine, before and after)

router.include_router(lora.router)

from . import songbird  # noqa: E402  (a two-voice syrinx synth; a model composes, code checks)

router.include_router(songbird.router)

router.include_router(storewatch.media)  # evidence clips for <video> tags, which cannot send the lab header

from . import tutor_people  # noqa: E402  (the tutor's people: faces and voices, including their own)

router.include_router(tutor_people.router)
router.include_router(tutor_people.media)  # uploaded avatars, for TalkingHead's loader
