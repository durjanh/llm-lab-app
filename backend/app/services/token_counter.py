"""The token counter: one prompt counted by many model families, exactly where the tokenizer or a counting API is
available, and as a labelled estimate where it is not.

- Claude: Anthropic's count_tokens (free). Its tokenizer is not published, so there are no pieces to show.
- GPT, Llama, Mistral, Qwen, DeepSeek: their published tokenizers, run here (gateways/hf_tokenizers.py), with the
  position of every token, so the page can colour the text.
- Gemini: Google publishes no tokenizer, and counting needs a Google key, so Gemma 2's tokenizer, which Google built
  from Gemini's, stands in. Marked as an estimate.
- The local model: its own server's count.

"Text tokens" are the system prompt's and the prompt's own tokens. "As a request" adds the framing a request carries
(turn markers), where the lab can count it: Claude, GPT and the local model.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import MessageSender
from ..gateways.hf_tokenizers import TokenizerSource
from ..shared import LOCAL_MODEL, PRICES, count_gpt_tokens

CLAUDE_CONTEXT = 1_000_000

# provider, id, name, how it is counted, tokenizer repo, exact, note
CATALOGUE: list[dict[str, Any]] = [
    {"id": "claude-opus-5-5", "provider": "Anthropic", "name": "Claude Opus 5.5", "how": "count_tokens"},
    {"id": "claude-sonnet-5-5", "provider": "Anthropic", "name": "Claude Sonnet 5.5", "how": "count_tokens"},
    {"id": "claude-haiku-5-5", "provider": "Anthropic", "name": "Claude Haiku 5.5", "how": "count_tokens"},
    {"id": "claude-opus-4-8", "provider": "Anthropic", "name": "Claude Opus 4.8", "how": "count_tokens"},
    {"id": "claude-sonnet-4-6", "provider": "Anthropic", "name": "Claude Sonnet 4.6", "how": "count_tokens"},
    {"id": "claude-haiku-4-5", "provider": "Anthropic", "name": "Claude Haiku 4.5", "how": "count_tokens"},
    {"id": "gpt-5.4-mini", "provider": "OpenAI", "name": "GPT-5.4 mini", "how": "tokenizer", "repo": "Xenova/gpt-4o",
     "note": "o200k_base, the tokenizer of GPT-4o, GPT-4.1 and GPT-5"},
    {"id": "gpt-4.1-mini", "provider": "OpenAI", "name": "GPT-4.1 mini", "how": "tokenizer", "repo": "Xenova/gpt-4o",
     "note": "o200k_base, the tokenizer of GPT-4o, GPT-4.1 and GPT-5"},
    {"id": "gemini", "provider": "Google", "name": "Gemini", "how": "tokenizer", "repo": "Xenova/gemma2-tokenizer",
     "exact": False, "note": "Estimate: Gemma 2's tokenizer, which Google built from Gemini's. An exact count needs "
                             "Google's countTokens API and a Google key."},
    {"id": "llama-4", "provider": "Meta", "name": "Llama 4", "how": "tokenizer", "repo": "Xenova/llama4-tokenizer",
     "note": "Llama 4's published tokenizer"},
    {"id": "llama-3", "provider": "Meta", "name": "Llama 3.1 to 3.3", "how": "tokenizer",
     "repo": "Xenova/Meta-Llama-3.1-Tokenizer", "note": "Llama 3's published tokenizer"},
    {"id": "mistral-tekken", "provider": "Mistral AI", "name": "Mistral NeMo (Tekken)", "how": "tokenizer",
     "repo": "Xenova/Mistral-Nemo-Instruct-Tokenizer", "note": "Tekken, Mistral's newer tokenizer"},
    {"id": "mistral-v3", "provider": "Mistral AI", "name": "Mistral 7B and Mixtral (v3)", "how": "tokenizer",
     "repo": "Xenova/mistral-tokenizer-v3", "note": "Mistral's v3 SentencePiece tokenizer"},
    {"id": "qwen3", "provider": "Alibaba", "name": "Qwen3", "how": "tokenizer", "repo": "Qwen/Qwen3-0.6B",
     "note": "Qwen3's published tokenizer"},
    {"id": "deepseek-v3", "provider": "DeepSeek", "name": "DeepSeek-V3 and R1", "how": "tokenizer",
     "repo": "deepseek-ai/DeepSeek-V3", "note": "DeepSeek-V3's published tokenizer"},
]


def segments(text: str, offsets: list[tuple[int, int]]) -> list[dict[str, Any]]:
    """The text cut at token boundaries, for colouring. A character split across several byte tokens (an emoji, some
    accented letters) is one segment with more than one token, so the tokens always add up to the count."""
    out: list[dict[str, Any]] = []
    cursor = 0
    for start, end in offsets:
        if end <= cursor and out:  # another byte of a character already shown
            out[-1]["tokens"] += 1
            continue
        start = max(start, cursor)
        if start > cursor:  # text a tokenizer folds into a neighbour (rare): keep it visible
            if out:
                out[-1]["text"] += text[cursor:start]
            else:
                out.append({"text": text[cursor:start], "tokens": 0})
        out.append({"text": text[start:end], "tokens": 1})
        cursor = end
    if cursor < len(text):
        if out:
            out[-1]["text"] += text[cursor:]
        else:
            out.append({"text": text[cursor:], "tokens": 0})
    return out


class TokenCounterService:
    def __init__(self, claude: MessageSender, tokenizers: TokenizerSource):
        self.claude, self.tokenizers = claude, tokenizers

    def catalogue(self) -> list[dict[str, Any]]:
        models = [dict(m) for m in CATALOGUE]
        if LOCAL_MODEL:
            models.append({"id": LOCAL_MODEL, "provider": "This machine", "name": LOCAL_MODEL.split("/")[-1] + " (local)",
                           "how": "count_tokens", "note": "The local model's own tokenizer, counted by its server"})
        for m in models:
            m.setdefault("exact", True)
            m.setdefault("note", "Anthropic's count_tokens (free); Claude's tokenizer is not published"
                         if m["id"].startswith("claude-") else "")
            price = PRICES.get(m["id"])
            m["input_price"] = price["input"] if price else None  # dollars per million input tokens
            m["context"] = CLAUDE_CONTEXT if m["id"].startswith("claude-") else None
            m["ready"] = m["how"] != "tokenizer" or self.tokenizers.cached(m["repo"])
        return models

    def _find(self, model_id: str) -> dict[str, Any]:
        found = next((m for m in self.catalogue() if m["id"] == model_id), None)
        if found is None:
            raise ApiError(400, "invalid_request", f"Unknown model {model_id}.")
        return found

    def _api(self, model: str, text: str, system: str = "") -> int:
        extra = {"system": system} if system else {}
        return self.claude.count_tokens(model=model, messages=[{"role": "user", "content": text}], **extra)

    def count(self, model_id: str, system: str, prompt: str) -> dict[str, Any]:
        m = self._find(model_id)
        try:
            if m["how"] == "tokenizer":
                parts = {name: segments(text, self.tokenizers.encode(m["repo"], text)) if text else []
                         for name, text in (("system", system), ("prompt", prompt))}
                tokens = {name: sum(s["tokens"] for s in segs) for name, segs in parts.items()}
                request = None
                if m["id"].startswith("gpt-"):  # GPT's framing was measured against Azure's bill (gpt_model.py)
                    request = count_gpt_tokens({"system": system or None, "messages": [{"role": "user", "content": prompt}]})
            else:
                with ThreadPoolExecutor(max_workers=4) as pool:
                    a = pool.submit(self._api, m["id"], "a")
                    p = pool.submit(self._api, m["id"], prompt)
                    s = pool.submit(self._api, m["id"], system) if system.strip() else None
                    total = pool.submit(self._api, m["id"], prompt, system)
                framing = a.result() - 1  # "a" is one token, so the rest is the framing around a message
                tokens = {"system": s.result() - framing if s else 0, "prompt": p.result() - framing}
                parts, request = None, total.result()
        except ApiError:
            raise
        except Exception as exc:
            raise to_api_error(exc) from exc
        text_tokens = tokens["system"] + tokens["prompt"]
        billed = request if request is not None else text_tokens
        return {**m, "tokens": text_tokens, "system_tokens": tokens["system"], "prompt_tokens": tokens["prompt"],
                "request_tokens": request, "segments": parts,
                "cost_usd": billed * m["input_price"] / 1_000_000 if m["input_price"] is not None else None,
                "ready": True}

    def compare(self, system: str, prompt: str) -> list[dict[str, Any]]:
        """Every model at once. The first run downloads the open tokenizers (about 90 MB, once)."""
        def one(m: dict[str, Any]) -> dict[str, Any]:
            try:
                r = self.count(m["id"], system, prompt)
                r.pop("segments", None)
                return r
            except Exception as exc:  # noqa: BLE001  (one tokenizer failing to download must not hide the others)
                return {**m, "tokens": None, "error": getattr(exc, "message", None) or str(exc)}
        with ThreadPoolExecutor(max_workers=6) as pool:
            return list(pool.map(one, self.catalogue()))

