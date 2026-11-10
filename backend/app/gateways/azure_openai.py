"""GPT models deployed in Microsoft Foundry, signed in with your Azure login (no keys).

The lab's Foundry resource (the same one that holds the speech service) has keys switched off, so
calls carry an Entra token from DefaultAzureCredential: run `az login` once. Only the document
automation lab offers GPT, beside Claude, for comparing the two on the same structured tasks.
"""
from __future__ import annotations

import json
import logging
from types import SimpleNamespace
from typing import Any, Protocol

from ..core.errors import ApiError

log = logging.getLogger("llm_lab")

# GPT prices live in python/common.py (GPT_PRICES, merged into PRICES), so the spend tracker charges GPT
# calls against the same budget as Claude's.


class StructuredModel(Protocol):
    models: list[str]

    def structured(self, model: str, system: str, schema: dict, content: Any, max_tokens: int) -> tuple[dict, Any]: ...


class AzureOpenAI:
    """Structured answers from a GPT deployment. The deployment name is the model name, e.g. gpt-5.4-mini."""

    def __init__(self, endpoint: str, deployments: list[str], embedding_deployment: str = ""):
        self.endpoint = endpoint.rstrip("/")
        self.models = [d for d in deployments if d]
        self.embedding_deployment = embedding_deployment
        self._client: Any = None

    def client(self) -> Any:
        if self._client is None:
            from azure.identity import DefaultAzureCredential, get_bearer_token_provider
            from openai import OpenAI

            token = get_bearer_token_provider(DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default")
            self._client = OpenAI(base_url=f"{self.endpoint}/openai/v1/", api_key=token)
        return self._client

    def structured(self, model: str, system: str, schema: dict, content: Any, max_tokens: int) -> tuple[dict, Any]:
        """One answer that must match the schema (strict structured outputs), and its token usage in the
        shape the spend tracker reads: input_tokens (uncached), cache_read_input_tokens, output_tokens."""
        message, usage = self.chat(model, [{"role": "system", "content": system}, {"role": "user", "content": to_openai(content)}],
                                   schema=schema, max_tokens=max_tokens)
        return json.loads(message.content or "{}"), usage

    def chat(self, model: str, messages: list[dict], *, tools: list[dict] | None = None, schema: dict | None = None,
             max_tokens: int = 4000) -> tuple[Any, Any]:
        """One Chat Completions turn: the assistant message (with any tool calls) and its usage. With a
        schema, the final answer must match it (strict structured outputs); tools may be offered alongside."""
        import openai

        params: dict[str, Any] = {"model": model, "max_completion_tokens": max_tokens, "messages": messages}
        if tools:
            params["tools"] = tools
        if schema:
            params["response_format"] = {"type": "json_schema", "json_schema": {"name": "answer", "schema": schema, "strict": True}}
        try:
            r = self.client().chat.completions.create(**params)
        except openai.RateLimitError as exc:
            raise ApiError(429, "rate_limited", "Azure OpenAI is busy (rate limited). Wait a moment and try again.") from exc
        except (openai.AuthenticationError, openai.PermissionDeniedError) as exc:
            raise ApiError(502, "azure_auth", "Azure refused the sign-in. Run az login, and check your account has the "
                                              "Cognitive Services OpenAI User role on the Foundry resource.") from exc
        except openai.APIError as exc:
            raise ApiError(502, "azure_error", f"Azure OpenAI failed: {exc}") from exc
        choice = r.choices[0]
        if choice.message.refusal:
            raise ApiError(422, "refused", f"{model} declined: {choice.message.refusal}")
        if choice.finish_reason == "length":
            raise ApiError(502, "too_long", f"{model}'s answer was cut off. Try a shorter document.")
        cached = getattr(getattr(r.usage, "prompt_tokens_details", None), "cached_tokens", 0) or 0
        usage = SimpleNamespace(input_tokens=r.usage.prompt_tokens - cached, cache_read_input_tokens=cached,
                                cache_creation_input_tokens=0, output_tokens=r.usage.completion_tokens)
        return choice.message, usage

    def embed(self, texts: list[str]) -> tuple[list[list[float]], Any]:
        """Embedding vectors for the texts, in order, and the usage for the spend tracker."""
        import openai

        if not self.embedding_deployment:
            raise ApiError(503, "not_configured", "Set AZURE_OPENAI_EMBEDDING_DEPLOYMENT to use embeddings.")
        try:
            r = self.client().embeddings.create(model=self.embedding_deployment, input=texts)
        except openai.APIError as exc:
            raise ApiError(502, "azure_error", f"Azure OpenAI embeddings failed: {exc}") from exc
        usage = SimpleNamespace(input_tokens=r.usage.prompt_tokens, cache_read_input_tokens=0,
                                cache_creation_input_tokens=0, output_tokens=0)
        return [d.embedding for d in sorted(r.data, key=lambda d: d.index)], usage


def to_openai(content: Any) -> Any:
    """Claude-style content blocks as Chat Completions parts: text stays text, a PDF becomes a file part."""
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if block["type"] == "text":
            parts.append({"type": "text", "text": block["text"]})
        elif block["type"] == "document" and block["source"].get("type") == "base64":
            src = block["source"]
            parts.append({"type": "file", "file": {"filename": block.get("title") or "document.pdf",
                                                   "file_data": f"data:{src['media_type']};base64,{src['data']}"}})
        else:
            raise ApiError(400, "invalid_request", f"GPT models here can't read a {block['type']} block.")
    return parts
