"""The one place that talks to the Anthropic SDK (an adapter). Services depend on the small protocols below."""
from __future__ import annotations

from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any, Protocol

import anthropic

from ..shared import CLAUDE_MODEL, create, stream


class MessageSender(Protocol):
    def create(self, **params: Any) -> Any: ...
    def stream(self, **params: Any) -> AbstractContextManager[Any]: ...
    def count_tokens(self, **params: Any) -> int: ...


class CredentialChecker(Protocol):
    def has_credentials(self) -> bool: ...


class FileStore(Protocol):
    def file_info(self, file_id: str) -> tuple[str, int | None]: ...
    def file_bytes(self, file_id: str) -> bytes: ...
    def upload(self, name: str, content: bytes, media_type: str, expires_in_s: int) -> str: ...
    def delete_file(self, file_id: str) -> None: ...


class ClaudeGateway:
    """Wraps the SDK client. Generation goes through the lesson scripts' create() and stream(),
    which switch on server-side refusal fallbacks where the model supports them."""

    def __init__(self, client: Any):
        self.client = client  # the lesson scripts' harness and skills runner take the client itself
        self._has_credentials: bool | None = None

    def create(self, **params: Any) -> Any:
        return create(self.client, **params)

    def stream(self, **params: Any) -> AbstractContextManager[Any]:
        return stream(self.client, **params)

    def count_tokens(self, **params: Any) -> int:
        return self.client.messages.count_tokens(**params).input_tokens

    def has_credentials(self) -> bool:
        """Checked once, with a metadata call that generates nothing."""
        if self._has_credentials is None:
            try:
                self.client.models.retrieve(CLAUDE_MODEL)
                self._has_credentials = True
            except anthropic.AuthenticationError:
                self._has_credentials = False
            except TypeError as exc:  # raised when no credentials can be found at all
                self._has_credentials = "authentication" not in str(exc).lower()
            except anthropic.APIError:
                self._has_credentials = True  # credentials exist; other problems surface on real calls
        return self._has_credentials

    def file_info(self, file_id: str) -> tuple[str, int | None]:
        """(name, size in bytes) of a file in the Files API."""
        meta = self.client.files.retrieve_metadata(file_id)
        return Path(meta.filename).name, getattr(meta, "size_bytes", None)  # never trust a path from outside

    def file_bytes(self, file_id: str) -> bytes:
        return self.client.files.download(file_id).read()

    def upload(self, name: str, content: bytes, media_type: str, expires_in_s: int) -> str:
        """Uploads a file to the Files API and returns its id. It is deleted automatically after expires_in_s."""
        return self.client.files.upload(file=(name, content, media_type), expires_in_seconds=expires_in_s).id

    def delete_file(self, file_id: str) -> None:
        self.client.files.delete(file_id)

    # ----- Message Batches API: half price, asynchronous, results in any order -----

    def batch_create(self, requests: list[dict[str, Any]]) -> dict[str, Any]:
        """Submits a batch. Each request is {custom_id, params}. Returns the batch id and when it expires."""
        batch = self.client.messages.batches.create(requests=requests)
        return {"id": batch.id, "expires_at": str(batch.expires_at)}

    def batch_retrieve(self, batch_id: str) -> dict[str, Any]:
        """The batch's processing status ("in_progress", "canceling" or "ended") and its request counts."""
        batch = self.client.messages.batches.retrieve(batch_id)
        counts = batch.request_counts
        return {"id": batch.id, "status": batch.processing_status,
                "counts": {k: getattr(counts, k, 0) for k in ("processing", "succeeded", "errored", "canceled", "expired")}}

    def batch_results(self, batch_id: str) -> list[dict[str, Any]]:
        """Every result of an ended batch, in the order Anthropic returns them (not the order sent): match on custom_id."""
        out: list[dict[str, Any]] = []
        for item in self.client.messages.batches.results(batch_id):
            outcome = item.result
            entry: dict[str, Any] = {"custom_id": item.custom_id, "type": outcome.type}
            if outcome.type == "succeeded":
                entry["message"] = outcome.message
            elif outcome.type == "errored":
                entry["error_type"] = outcome.error.error.type
                entry["error_message"] = getattr(outcome.error.error, "message", "")
            out.append(entry)
        return out
