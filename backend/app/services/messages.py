"""Single requests to Claude for the pages: one reply, one streamed reply, or a token count."""
from __future__ import annotations

import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Iterator
from typing import Any

import anthropic

from ..core.errors import describe, to_api_error
from ..shared import gpt_pieces
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

    def breakdown(self, model: str, system: str, prompt: str) -> dict[str, Any]:
        try:
            result = token_breakdown(self.claude.count_tokens, model, system, prompt)
            if model.startswith("gpt-"):  # GPT's tokenizer is published, so its exact pieces can be shown too
                result["pieces"] = gpt_pieces(prompt)
            return result
        except Exception as exc:
            raise to_api_error(exc) from exc

    def count_tokens(self, params: dict[str, Any]) -> int:
        keep = {k: params[k] for k in ("model", "messages", "system", "tools") if k in params}
        try:
            return self.claude.count_tokens(**keep)
        except Exception as exc:
            raise to_api_error(exc) from exc


MAX_PIECES = 150  # counts per breakdown; longer prompts are measured a few words at a time


def split_words(prompt: str) -> list[str]:
    """Words with the whitespace before them, as tokenizers see them (" leave"). Joined, they give the prompt back."""
    pieces = re.findall(r"\s*\S+", prompt)
    tail = prompt[len("".join(pieces)):]
    if pieces and tail:
        pieces[-1] += tail
    if len(pieces) > MAX_PIECES:
        size = math.ceil(len(pieces) / MAX_PIECES)
        pieces = ["".join(pieces[i:i + size]) for i in range(0, len(pieces), size)]
    return pieces


def token_breakdown(count: Any, model: str, system: str, prompt: str) -> dict[str, Any]:
    """Where a prompt's tokens go, measured with count_tokens alone, because Claude's tokenizer is not published.

    The prompt is counted as it grows, one word at a time: the rise at each word is the tokens it added. "a" is one
    token, which separates the framing around a message from the system prompt. The parts add up to the total
    exactly, because each step is the difference between two real counts."""
    pieces = split_words(prompt)
    with_system = {"system": system} if system.strip() else {}

    def n(text: str, sys: dict[str, Any]) -> int:
        return count(model=model, messages=[{"role": "user", "content": text}], **sys)

    prefixes = ["".join(pieces[:i + 1]) for i in range(len(pieces))]
    with ThreadPoolExecutor(max_workers=8) as pool:
        bare = pool.submit(n, "a", {})
        base = pool.submit(n, "a", with_system)
        counts = list(pool.map(lambda t: n(t, with_system), prefixes))
    framing = bare.result() - 1
    system_tokens = base.result() - bare.result()
    previous, words = framing + system_tokens, []
    for piece, c in zip(pieces, counts):
        words.append({"text": piece, "tokens": c - previous})
        previous = c
    total = counts[-1] if counts else base.result()
    return {"model": model, "total": total, "framing": framing, "system": system_tokens,
            "prompt": total - framing - system_tokens, "words": words, "grouped": len(pieces) < len(re.findall(r"\S+", prompt))}
