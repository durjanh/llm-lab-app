"""Image to 3D: one photo to an object made of Gaussian splats with Idol, on this machine. It costs nothing, so there
is no budget guard; one run at a time."""
from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Form, Path, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from ..core.body_limit import FORM_OVERHEAD, LimitedRoute, limit
from ..services.image_to_3d import MAX_IMAGE_BYTES, ImageTo3DService
from .deps import image_to_3d, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)], route_class=LimitedRoute)
ResultId = Annotated[str, Path(pattern=r"^[0-9a-f]{12}$")]


@router.get("/image-to-3d/info")
def info(service: ImageTo3DService = Depends(image_to_3d)) -> dict[str, Any]:
    return service.info()


@router.post("/image-to-3d/generate", openapi_extra=limit(MAX_IMAGE_BYTES + FORM_OVERHEAD))
async def generate(file: UploadFile, mode: Annotated[Literal["real", "synthetic"], Form()] = "real",
                   seed: Annotated[int, Form(ge=0, le=100_000)] = 42, steps: Annotated[int, Form(ge=5, le=100)] = 50,
                   num_gaussians: Annotated[int, Form()] = 262_144,
                   service: ImageTo3DService = Depends(image_to_3d)) -> StreamingResponse:
    """The photo and its settings in; progress, then the result, streamed as NDJSON."""
    image = await file.read(MAX_IMAGE_BYTES + 1)
    lines = service.generate(image, {"mode": mode, "seed": seed, "steps": steps, "num_gaussians": num_gaussians})
    return StreamingResponse(lines, media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@router.post("/image-to-3d/cancel")
def cancel(service: ImageTo3DService = Depends(image_to_3d)) -> dict[str, Any]:
    return service.cancel()


@router.get("/image-to-3d/results/{result_id}/{name}")
def result_file(result_id: ResultId, name: str, service: ImageTo3DService = Depends(image_to_3d)) -> FileResponse:
    """object.ply, input.png or camera.json. The page fetches them with the lab header, so this stays guarded."""
    path, media = service.file(result_id, name)
    return FileResponse(path, media_type=media, headers={"Cache-Control": "no-store"})


@router.delete("/image-to-3d/results/{result_id}")
def remove(result_id: ResultId, service: ImageTo3DService = Depends(image_to_3d)) -> dict[str, Any]:
    return service.remove(result_id)
