"""The control layer: the page's routes (policies, keys, figures) and the Anthropic-compatible proxy for outside coding
agents. The page's routes need the lab header like every page; the proxy needs a virtual key instead, and answers
only to this machine."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..core.errors import ApiError
from ..core.body_limit import MB, LimitedRoute, limit
from ..settings import MODELS
from .deps import Container, container, require_lab_page

router = APIRouter(dependencies=[Depends(require_lab_page)])


def service(c: Container = Depends(container)) -> Any:
    return c.control_layer


class KeyRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)


@router.get("/control-layer")
def overview(svc: Any = Depends(service)) -> dict[str, Any]:
    """Usage and cost by consumer, model and day; budgets, routing savings, blocked calls, keys and the audit log."""
    return svc.overview()


@router.put("/control-layer/policies/{consumer}")
def set_policy(consumer: str, body: dict[str, Any], svc: Any = Depends(service)) -> dict[str, Any]:
    """Sets or replaces one consumer's policy. Every change goes in the audit log."""
    return svc.control.set_policy(consumer, body)


@router.delete("/control-layer/policies/{consumer}", status_code=204)
def remove_policy(consumer: str, svc: Any = Depends(service)) -> Response:
    svc.control.remove_policy(consumer)
    return Response(status_code=204)


@router.post("/control-layer/keys")
def create_key(body: KeyRequest, svc: Any = Depends(service)) -> dict[str, Any]:
    """A new virtual key. The key itself is in this response only; the lab keeps its hash."""
    return svc.control.create_key(body.name)


@router.delete("/control-layer/keys/{key_id}", status_code=204)
def revoke_key(key_id: str, svc: Any = Depends(service)) -> Response:
    svc.control.revoke_key(key_id)
    return Response(status_code=204)


# ---------- the proxy: /control/v1/..., for tools pointed at ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/control ----------

proxy = APIRouter(prefix="/control/v1", route_class=LimitedRoute)


def _fail(status: int, message: str) -> JSONResponse:
    from ..services.control_layer_service import anthropic_error
    return JSONResponse(anthropic_error(status, message), status_code=status)


def _caller(request: Request, c: Container) -> dict[str, Any] | JSONResponse:
    """The virtual key behind a request, or the error to send. The lab header is not enough: a key is required."""
    if request.headers.get("host") not in c.settings.allowed_hosts:
        return _fail(403, "The control layer's proxy answers only to this machine.")
    presented = request.headers.get("x-api-key")
    auth = request.headers.get("authorization", "")
    if not presented and auth.lower().startswith("bearer "):
        presented = auth[7:].strip()
    record = c.control.authenticate(presented)
    if record is None:
        return _fail(401, "A valid virtual key from the control layer page is required (x-api-key or a bearer token).")
    return record


async def _body(request: Request) -> Any:
    try:
        return await request.json()
    except ValueError:
        raise ApiError(400, "invalid_request", "The body must be JSON.") from None


@proxy.post("/messages", openapi_extra=limit(32 * MB))  # a long conversation with pictures, not a video
async def messages(request: Request, c: Container = Depends(container)) -> Any:
    """The Messages API, streamed or not, under the calling key's policy and the lab's own gateway."""
    caller = _caller(request, c)
    if isinstance(caller, JSONResponse):
        return caller
    consumer = f"key:{caller['id']}"
    beta = request.headers.get("anthropic-beta")
    try:
        body = await _body(request)
        params = c.control_layer.check_request(body)  # checked once, here: fields, tools, content, stream's type
        if body.get("stream") is True:
            lines = await run_in_threadpool(c.control_layer.open_stream, consumer, params, beta)
            return StreamingResponse(lines, media_type="text/event-stream",
                                     headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
        return JSONResponse(await run_in_threadpool(c.control_layer.create, consumer, params, beta))
    except ApiError as exc:
        return _fail(exc.status, exc.message)
    except Exception as exc:  # noqa: BLE001 - an upstream failure, in the Messages API's error shape
        from ..services.control_layer_service import upstream_status
        status, message = upstream_status(exc)
        return _fail(status, message)


@proxy.post("/messages/count_tokens", openapi_extra=limit(32 * MB))
async def count_tokens(request: Request, c: Container = Depends(container)) -> Any:
    caller = _caller(request, c)
    if isinstance(caller, JSONResponse):
        return caller
    try:
        return JSONResponse(await run_in_threadpool(c.control_layer.count_tokens, await _body(request)))
    except ApiError as exc:
        return _fail(exc.status, exc.message)
    except Exception as exc:  # noqa: BLE001
        from ..services.control_layer_service import upstream_status
        status, message = upstream_status(exc)
        return _fail(status, message)


@proxy.get("/models")
def models(request: Request, c: Container = Depends(container)) -> Any:
    caller = _caller(request, c)
    if isinstance(caller, JSONResponse):
        return caller
    data = [{"type": "model", "id": m, "display_name": m, "created_at": "2026-01-01T00:00:00Z"} for m in MODELS]
    return {"data": data, "has_more": False, "first_id": data[0]["id"] if data else None,
            "last_id": data[-1]["id"] if data else None}
