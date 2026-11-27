"""A ceiling on request bodies, applied before anything reads them.

An upload route that checks the size itself (`await file.read(limit + 1)`) runs only after Starlette has parsed the whole
multipart body into a temporary file, so a multi-gigabyte POST is taken in full before it is refused. This middleware
refuses a body over its route's limit first: at once when Content-Length says so, or as soon as the bytes read pass the
limit when the body is sent in chunks without one.

Two levels. `BodyLimit`, the middleware, holds every request to the app's ceiling. A route that takes less says so
where it is declared, with `openapi_extra=limit(n)` in its route decorator, or `default_limit(router, n)` for a whole
router, on a router made with `route_class=LimitedRoute`. That route checks its own limit after FastAPI has matched it
and before FastAPI reads the body, the same two ways, so no list of paths needs keeping in step with the routers. The
limit also shows in the API docs (/docs).
"""
from __future__ import annotations

from typing import Any, Callable, Coroutine

from fastapi import Request, Response
from fastapi.routing import APIRoute

from .errors import error_response

MB = 2**20
FORM_OVERHEAD = 64 * 1024  # the multipart wrapping around a file: boundaries, headers, the other fields


class BodyTooLarge(Exception):
    """Raised from receive() to stop whatever is reading the body."""


KEY = "x-body-limit"


def limit(max_bytes: int) -> dict[str, int]:
    """A route's own body limit, as its route decorator's `openapi_extra`:
    `@router.post(path, openapi_extra=limit(n))`."""
    return {KEY: max_bytes}


def default_limit(router: Any, max_bytes: int) -> None:
    """Gives every route on `router` without a limit of its own this one: for a router whose routes take JSON, so a
    route added later is covered without being listed. Call it after the router's routes are declared."""
    for route in router.routes:
        if hasattr(route, "openapi_extra") and KEY not in (route.openapi_extra or {}):
            route.openapi_extra = {**(route.openapi_extra or {}), KEY: max_bytes}


def _counting(receive: Any, cap: int) -> tuple[Any, Callable[[], bool]]:
    """`receive`, raising BodyTooLarge once more than `cap` bytes of body have come in; and whether it has."""
    read, over = 0, False

    async def counted() -> dict:
        nonlocal read, over
        message = await receive()
        if message["type"] == "http.request":
            read += len(message.get("body", b""))
            if read > cap:
                over = True
                raise BodyTooLarge
        return message
    return counted, lambda: over


def _declared_over(headers: Any, cap: int) -> bool:
    declared = headers.get(b"content-length") if isinstance(headers, dict) else headers.get("content-length")
    if isinstance(declared, bytes):
        declared = declared.decode("latin-1")
    return declared is not None and declared.isdigit() and int(declared) > cap


class LimitedRoute(APIRoute):
    """A route that refuses a body over its own declared limit (`limit()`, `default_limit()`) before it is read: at
    once when Content-Length says so, or as soon as the bytes read pass it. A route with no limit of its own is an
    ordinary APIRoute, held only to the app's ceiling."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handle = super().get_route_handler()

        async def limited(request: Request) -> Response:
            cap = (self.openapi_extra or {}).get(KEY)  # read per request: default_limit() runs after the route is made
            if cap is None:
                return await handle(request)
            if _declared_over(request.headers, cap):
                return too_large(cap)
            receive, over = _counting(request.receive, cap)
            try:
                return await handle(Request(request.scope, receive))
            except Exception:
                if over():  # FastAPI turns a body cut short into a 400; it was this limit
                    return too_large(cap)
                raise
        return limited


class BodyLimit:
    """ASGI middleware: the app's ceiling, `default` bytes, for every request, before any route is matched."""

    def __init__(self, app: Any, default: int):
        self.app, self.default = app, default

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        cap = self.default
        if _declared_over(dict(scope.get("headers") or []), cap):
            await too_large(cap)(scope, receive, send)
            return
        counted, over = _counting(receive, cap)
        started = False

        async def guarded(message: dict) -> None:
            nonlocal started
            if over():  # the app's answer to a body cut short (FastAPI makes it a 400) is replaced by the 413 below
                return
            started = True
            await send(message)

        try:
            await self.app(scope, counted, guarded)
        except Exception:
            if not over():
                raise
        if over() and not started:
            await too_large(cap)(scope, receive, send)


def too_large(limit: int) -> Any:
    shown = f"{limit / MB:.1f} MB" if limit >= MB else f"{limit // 1024} KB"
    return error_response(413, "too_large", f"The request is too large: this route takes at most {shown}.")
