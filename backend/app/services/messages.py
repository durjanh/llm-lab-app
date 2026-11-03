"""Single requests to Claude for the pages: one reply, one streamed reply, or a token count."""
from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Any

import anthropic

from ..core.errors import describe, to_api_error
from ..gateways.claude import MessageSender
from .spend import SpendTracker


def dump(message: Any) -> dict[str, Any]:
    return message.model_dump(mode="json", by_alias=True, exclude_none=True)


class MessagesService:
    def __init__(self, claude: MessageSender, spend: SpendTracker):
        self.claude, self.spend = claude, spend

    def send(self, params: dict[str, Any]) -> dict[str, Any]:
        start = time.perf_counter()
        try:
            message = self.claude.create(**params)
        except Exception as exc:
            raise to_api_error(exc) from exc
        cost = self.spend.charge(message, params["model"])
        return {"message": dump(message), "timing": {"total_ms": round((time.perf_counter() - start) * 1000)},
                "cost_usd": cost, "spent_usd": round(self.spend.spent_usd, 4)}

    def stream(self, params: dict[str, Any]) -> Iterator[dict[str, Any]]:
        """{"type": "text"} events as text arrives, then one {"type": "done"} or {"type": "error"}."""
        start, first = time.perf_counter(), None
        try:
            with self.claude.stream(**params) as s:
                for text in s.text_stream:
                    first = first or time.perf_counter()
                    yield {"type": "text", "text": text}
                message = s.get_final_message()
        except anthropic.APIStatusError as exc:
            yield {"type": "error", "message": f"API error {exc.status_code}: {exc.message}"}
            return
        except Exception as exc:
            yield {"type": "error", "message": describe(exc)}
            return
        end = time.perf_counter()
        cost = self.spend.charge(message, params["model"])
        yield {"type": "done", "message": dump(message),
               "timing": {"ttft_ms": round(((first or end) - start) * 1000), "total_ms": round((end - start) * 1000)},
               "cost_usd": cost, "spent_usd": round(self.spend.spent_usd, 4)}

    def count_tokens(self, params: dict[str, Any]) -> int:
        keep = {k: params[k] for k in ("model", "messages", "system", "tools") if k in params}
        try:
            return self.claude.count_tokens(**keep)
        except Exception as exc:
            raise to_api_error(exc) from exc
