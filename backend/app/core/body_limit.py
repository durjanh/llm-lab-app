"""A ceiling on request bodies, applied before anything reads them.

An upload route that checks the size itself (`await file.read(limit + 1)`) runs only after Starlette has parsed the whole
multipart body into a temporary file, so a multi-gigabyte POST is taken in full before it is refused. This middleware
refuses a body over its route's limit first: at once when Content-Length says so, or as soon as the bytes read pass the
limit when the body is sent in chunks without one.
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from .errors import error_response

MB = 2**20
FORM_OVERHEAD = 64 * 1024  # the multipart wrapping around a file: boundaries, headers, the other fields


class BodyTooLarge(Exception):
    """Raised from receive() to stop whatever is reading the body."""


class BodyLimit:
    """ASGI middleware: `default` bytes for any request, or the limit of the first route pattern that matches its path."""

    def __init__(self, app: Any, default: int, routes: Sequence[tuple[str, int]] = ()):
        self.app, self.default = app, default
        self.routes = [(re.compile(pattern), limit) for pattern, limit in routes]

    def limit_for(self, path: str) -> int:
        return next((limit for pattern, limit in self.routes if pattern.fullmatch(path)), self.default)

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self.limit_for(scope.get("path", ""))
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            await too_large(limit)(scope, receive, send)
            return
        read, over, started = 0, False, False

        async def counted() -> dict:
            nonlocal read, over
            message = await receive()
            if message["type"] == "http.request":
                read += len(message.get("body", b""))
                if read > limit:
                    over = True
                    raise BodyTooLarge
            return message

        async def guarded(message: dict) -> None:
            nonlocal started
            if over:  # the app's answer to a body cut short (FastAPI makes it a 400) is replaced by the 413 below
                return
            started = True
            await send(message)

        try:
            await self.app(scope, counted, guarded)
        except Exception:
            if not over:
                raise
        if over and not started:
            await too_large(limit)(scope, receive, send)


def too_large(limit: int) -> Any:
    shown = f"{limit / MB:.1f} MB" if limit >= MB else f"{limit // 1024} KB"
    return error_response(413, "too_large", f"The request is too large: this route takes at most {shown}.")
