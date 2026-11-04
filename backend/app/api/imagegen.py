"""Image generation with gpt-image-2: from a prompt, from reference images and with a mask, plus provenance and checks."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from ..schemas import ImageEdit, ImageGenerate, ImageRef
from ..services.imagegen import ImageGenService
from .deps import imagegen, require_budget, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])
media = APIRouter()  # <img> tags cannot send the lab header; these images are already made
PAID = [Depends(require_budget)]


@router.get("/imagegen/info")
def info(service: ImageGenService = Depends(imagegen)) -> dict[str, Any]:
    return service.info()


@media.get("/imagegen/images/{ref}")
def image(ref: str, service: ImageGenService = Depends(imagegen)) -> Response:
    return Response(service.image(ref), media_type="image/png", headers={"Cache-Control": "max-age=3600"})


@router.post("/imagegen/generate", dependencies=PAID)
def generate(body: ImageGenerate, service: ImageGenService = Depends(imagegen)) -> dict[str, Any]:
    return service.generate(body.prompt, body.size, body.quality, body.background, body.n)


@router.post("/imagegen/edit", dependencies=PAID)
def edit(body: ImageEdit, service: ImageGenService = Depends(imagegen)) -> dict[str, Any]:
    return service.edit(body.prompt, body.images, body.mask, body.size, body.quality)


@router.post("/imagegen/watermark")
def watermark(body: ImageRef, service: ImageGenService = Depends(imagegen)) -> dict[str, Any]:
    return service.watermark(body.id, body.text)


@router.post("/imagegen/check", dependencies=PAID)
def check(body: ImageRef, service: ImageGenService = Depends(imagegen)) -> dict[str, Any]:
    return service.check(body.id)
