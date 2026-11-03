"""Errors the API returns, and the translation of Claude SDK failures into them."""
from __future__ import annotations

import anthropic
from fastapi.responses import JSONResponse

from ..shared import Refused


class ApiError(Exception):
    """A failure the page should see, with an HTTP status, a short type and a readable message."""

    def __init__(self, status: int, kind: str, message: str):
        super().__init__(message)
        self.status, self.kind, self.message = status, kind, message


def error_response(status: int, kind: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"type": kind, "message": message}}, status_code=status,
                        headers={"Cache-Control": "no-store"})


def to_api_error(exc: Exception) -> ApiError:
    """Turns a Claude SDK failure into an ApiError. Anything else is a bug, so it is raised again."""
    if isinstance(exc, ApiError):
        return exc
    if isinstance(exc, Refused):
        return ApiError(422, "refused", str(exc))
    if isinstance(exc, anthropic.APIStatusError):
        return ApiError(exc.status_code, "api_error", exc.message)
    if isinstance(exc, anthropic.APIConnectionError):
        return ApiError(502, "connection_error", "Could not reach the Claude API.")
    if isinstance(exc, TypeError) and "authentication" in str(exc).lower():
        return ApiError(401, "no_credentials", "No API credentials. Set ANTHROPIC_API_KEY and restart the server.")
    raise exc


def describe(exc: Exception) -> str:
    """A readable message for any failure, for errors reported inside a stream rather than as a status code."""
    try:
        return to_api_error(exc).message
    except Exception:
        return f"{type(exc).__name__}: {exc}"
