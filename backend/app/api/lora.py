"""Fine-tuning with LoRA: train an adapter on this machine, score it, and try it. Training runs locally and costs
nothing, so there is no budget guard; one run at a time."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..services.lora import LoraService
from .deps import lora, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


class LoraTrain(BaseModel):
    model_id: str = Field(min_length=1, max_length=100)
    r: int = Field(default=16, ge=1, le=128)
    alpha: int = Field(default=32, ge=1, le=512)
    dropout: float = Field(default=0.05, ge=0.0, le=0.5)
    targets: list[str] = Field(min_length=1, max_length=7)
    lr: float = Field(default=5e-4, gt=0, le=1e-2)
    steps: int = Field(default=80, ge=5, le=600)
    batch: int = Field(default=8, ge=1, le=32)
    seed: int = Field(default=0, ge=0, le=10_000)


class LoraCard(BaseModel):
    repo_id: str = Field(min_length=3, max_length=200)


class LoraPublish(BaseModel):
    repo_id: str = Field(min_length=3, max_length=200)
    private: bool = True
    card: str = Field(min_length=20, max_length=50_000)
    replace_existing: bool = False  # the repo exists: the page showed what an upload replaces, and the person agreed
    confirm: Literal[True]  # the page asks the person first; without it nothing is sent


class LoraTry(BaseModel):
    email: str = Field(min_length=10, max_length=2000)
    adapter_id: str | None = Field(default=None, max_length=12)


@router.get("/lora/info")
def info(service: LoraService = Depends(lora)) -> dict[str, Any]:
    return service.info()


@router.post("/lora/train")
def train(body: LoraTrain, service: LoraService = Depends(lora)) -> StreamingResponse:
    """Scores before, trains, scores after, streamed as NDJSON."""
    return StreamingResponse(service.train(body.model_dump()), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


@router.post("/lora/cancel")
def cancel(service: LoraService = Depends(lora)) -> dict[str, Any]:
    return service.cancel()


@router.post("/lora/try")
def try_email(body: LoraTry, service: LoraService = Depends(lora)) -> dict[str, Any]:
    """The base model and an adapter on one email of your own."""
    return service.try_email(body.email, body.adapter_id)


@router.delete("/lora/adapters/{adapter_id}")
def remove(adapter_id: str, service: LoraService = Depends(lora)) -> dict[str, Any]:
    return service.remove(adapter_id)


@router.get("/lora/account")
def account(model_id: str | None = None, service: LoraService = Depends(lora)) -> dict[str, Any]:
    """Who the LoRA environment is signed in to Hugging Face as, or how to sign in."""
    return service.account(model_id)


@router.post("/lora/adapters/{adapter_id}/card")
def card(adapter_id: str, body: LoraCard, service: LoraService = Depends(lora)) -> dict[str, Any]:
    """The model card that would be published, from the adapter's saved scores."""
    return service.card(adapter_id, body.repo_id)


@router.post("/lora/adapters/{adapter_id}/publish")
def publish(adapter_id: str, body: LoraPublish, service: LoraService = Depends(lora)) -> dict[str, Any]:
    """Uploads the adapter and its card to Hugging Face, under the signed-in account. Only when the person confirms."""
    return service.publish(adapter_id, body.repo_id, body.private, body.card, body.replace_existing)
