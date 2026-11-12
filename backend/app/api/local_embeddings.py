"""Embeddings from the open model on this machine (Docker Model Runner), for the embeddings page. Free, so there is no
budget guard; the number and size of texts are capped instead."""
from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, StringConstraints

from ..core.errors import ApiError
from ..gateways.local_embeddings import LocalEmbedder, LocalEmbeddingsUnavailable
from .deps import local_embeddings, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])

Text = Annotated[str, StringConstraints(min_length=1, max_length=4000)]


class LocalEmbedRequest(BaseModel):
    texts: list[Text] = Field(min_length=1, max_length=128)
    kind: Literal["document", "query"] = "document"  # a stored passage, or a question to match against passages


@router.get("/embeddings/local")
def info(embedder: LocalEmbedder = Depends(local_embeddings)) -> dict[str, Any]:
    """Whether a local embedding model is set up and its server is running."""
    return embedder.status()


@router.post("/embeddings/local")
def embed(body: LocalEmbedRequest, embedder: LocalEmbedder = Depends(local_embeddings)) -> dict[str, Any]:
    """One unit-length vector per text, from the local model."""
    try:
        vectors = embedder.embed(body.texts, body.kind)
    except LocalEmbeddingsUnavailable as exc:
        raise ApiError(503, "local_embeddings_unavailable", str(exc)) from exc
    return {"model": embedder.model, "dims": len(vectors[0]), "vectors": vectors}
