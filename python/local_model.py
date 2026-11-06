"""Sends Messages API calls for a local open model to a server on this machine, and everything else to Claude.

Docker Model Runner (and Ollama) serve the Anthropic Messages API, so the lab calls a local model with the same SDK and
the same request shapes. A few things differ, and they are handled here so no page has to know:
- Open reasoning models such as Qwen think before every answer unless told not to. Thinking is switched off unless the
  request asks for it (thinking: enabled or adaptive), so short answers are quick and do not run out of tokens.
- The local Anthropic endpoint ignores output_config's JSON schema. A request that needs one is sent to the server's
  OpenAI-compatible endpoint instead, where llama.cpp holds the reply to the schema with a grammar.
- What only Anthropic runs (server tools such as web search, code execution containers, the Files API, skills, MCP
  connectors, PDF documents) is refused with a clear message. Dropping it quietly would change what a page is testing.
A local model costs nothing per token, so it is priced at zero.
"""
from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

import anthropic
import httpx

from settings import ENV

LOCAL_MODEL = ENV.local_model
LOCAL_PRICE = {"input": 0.0, "output": 0.0, "cache_read": 0.0}

# Parameters the local server has no use for; they only matter on Anthropic's API.
IGNORED = ("betas", "fallbacks", "service_tier", "context_management", "inference_geo", "metadata")
CLAUDE_ONLY_PARAMS = {"container": "a code execution container", "mcp_servers": "MCP connectors",
                      "skills": "Agent Skills"}
# Content blocks a local model cannot take: files held by Anthropic, PDFs, and results of Anthropic's own tools.
CLAUDE_ONLY_BLOCKS = {"document": "PDF and document blocks", "container_upload": "files for code execution",
                      "server_tool_use": "Anthropic's server tools", "web_search_tool_result": "web search",
                      "web_fetch_tool_result": "web fetch", "code_execution_tool_result": "code execution",
                      "mcp_tool_use": "MCP connectors", "search_result": "search result blocks"}


class LocalUnsupported(ValueError):
    """The request needs something only Claude has. The message says what, so the person can pick a Claude model."""


class LocalUnavailable(RuntimeError):
    """The local model server is not answering."""


def is_local(model: Any) -> bool:
    return bool(LOCAL_MODEL) and model == LOCAL_MODEL


def _field(block: Any, name: str) -> Any:
    return block.get(name) if isinstance(block, dict) else getattr(block, name, None)


def _refuse(what: str) -> LocalUnsupported:
    return LocalUnsupported(f"{LOCAL_MODEL} runs on this machine and cannot use {what}. Choose a Claude model for this.")


def _check(params: dict) -> None:
    for name, what in CLAUDE_ONLY_PARAMS.items():
        if params.get(name):
            raise _refuse(what)
    for t in params.get("tools") or []:
        kind = _field(t, "type")
        if kind not in (None, "custom"):  # web_search_..., code_execution_..., bash_..., text_editor_..., memory_...
            raise _refuse(f"Anthropic's {_field(t, 'name') or kind} tool")
    for m in params.get("messages") or []:
        content = _field(m, "content")
        for block in content if isinstance(content, list) else []:
            kind = _field(block, "type")
            if kind in CLAUDE_ONLY_BLOCKS:
                raise _refuse(CLAUDE_ONLY_BLOCKS[kind])
            source = _field(block, "source")
            if source is not None and _field(source, "type") == "file":
                raise _refuse("files in Anthropic's Files API")


def _thinking_wanted(params: dict) -> bool:
    return (params.get("thinking") or {}).get("type") in ("enabled", "adaptive")


def prepare(params: dict) -> tuple[dict, dict | None]:
    """The request as the local server takes it, and the JSON schema the reply must match, if any."""
    _check(params)
    out = {k: v for k, v in params.items() if k not in IGNORED}
    schema = None
    config = out.pop("output_config", None) or {}
    fmt = config.get("format") or {}
    if fmt.get("type") == "json_schema":
        schema = fmt.get("schema")
    thinking = _thinking_wanted(out)
    out.pop("thinking", None)
    extra = dict(out.pop("extra_body", None) or {})
    extra["chat_template_kwargs"] = {**extra.get("chat_template_kwargs", {}), "enable_thinking": thinking}
    out["extra_body"] = extra
    return out, schema


def _system_text(system: Any) -> str:
    if isinstance(system, list):
        return "\n\n".join(_field(b, "text") or "" for b in system)
    return system or ""


def _with_schema_instruction(params: dict, schema: dict) -> dict:
    """For a reply that must be JSON but cannot go through the grammar (tools, or streaming): ask for it plainly."""
    rule = ("Reply with one JSON object and nothing else: no prose, no code fences. It must match this JSON schema:\n"
            + json.dumps(schema))
    system = _system_text(params.get("system"))
    return {**params, "system": f"{system}\n\n{rule}" if system else rule}


def _to_chat(params: dict) -> list[dict] | None:
    """Messages in OpenAI chat form, for a plain conversation (text and images). None if it has tool calls."""
    chat = [{"role": "system", "content": _system_text(params["system"])}] if params.get("system") else []
    for m in params["messages"]:
        content = _field(m, "content")
        if isinstance(content, str):
            chat.append({"role": _field(m, "role"), "content": content})
            continue
        parts = []
        for b in content:
            kind = _field(b, "type")
            if kind == "text":
                parts.append({"type": "text", "text": _field(b, "text")})
            elif kind == "image" and _field(_field(b, "source"), "type") == "base64":
                src = _field(b, "source")
                parts.append({"type": "image_url",
                              "image_url": {"url": f"data:{_field(src, 'media_type')};base64,{_field(src, 'data')}"}})
            elif kind in ("thinking", "redacted_thinking"):
                continue
            else:
                return None
        chat.append({"role": _field(m, "role"), "content": parts})
    return chat


class LocalModel:
    """The local server, through its Anthropic-compatible API (and its OpenAI-compatible one for JSON schemas)."""

    def __init__(self, url: str = ENV.local_url, openai_url: str = ENV.local_openai_url):
        self.url, self.openai_url = url, openai_url
        # A timeout of our own: the SDK refuses long non-streaming requests under its default, and a local model on a
        # laptop is slower than the API.
        self.client = anthropic.Anthropic(base_url=url, api_key="local", max_retries=0, timeout=900.0)

    def _unavailable(self) -> LocalUnavailable:
        return LocalUnavailable(f"The local model {LOCAL_MODEL} is not answering at {self.url}. Start it with "
                                "./tools/local-model.sh, or choose a Claude model.")

    def create(self, params: dict) -> Any:
        body, schema = prepare(params)
        try:
            if schema is not None:
                chat = None if body.get("tools") else _to_chat(body)
                if chat is not None:
                    return self._create_json(body, chat, schema)
                body = _with_schema_instruction(body, schema)
            return self.client.messages.create(**body)
        except anthropic.APIConnectionError as exc:
            raise self._unavailable() from exc

    @contextmanager
    def stream(self, params: dict) -> Iterator[Any]:
        body, schema = prepare(params)
        if schema is not None:
            body = _with_schema_instruction(body, schema)
        try:
            with self.client.messages.stream(**body) as s:
                yield s
        except anthropic.APIConnectionError as exc:
            raise self._unavailable() from exc

    def count_tokens(self, params: dict) -> Any:
        body, _ = prepare(params)
        body.pop("max_tokens", None)
        body.pop("extra_body", None)
        try:
            return self.client.messages.count_tokens(**body)
        except anthropic.APIConnectionError as exc:
            raise self._unavailable() from exc

    def _create_json(self, body: dict, chat: list[dict], schema: dict) -> anthropic.types.Message:
        """A reply held to the schema by the server's grammar, returned as an ordinary Anthropic Message."""
        payload = {"model": body["model"], "messages": chat, "max_tokens": body.get("max_tokens", 4096),
                   "response_format": {"type": "json_schema",
                                       "json_schema": {"name": "reply", "strict": True, "schema": schema}},
                   "chat_template_kwargs": {"enable_thinking": False}}
        for key in ("temperature", "top_p", "stop_sequences"):
            if key in body:
                payload["stop" if key == "stop_sequences" else key] = body[key]
        try:
            r = httpx.post(f"{self.openai_url}/chat/completions", json=payload, timeout=900.0)
        except httpx.ConnectError as exc:
            raise self._unavailable() from exc
        if r.status_code >= 400:
            raise anthropic.APIStatusError(f"Local model: {r.text[:300]}", response=r, body=None)
        data = r.json()
        choice, usage = data["choices"][0], data.get("usage") or {}
        return anthropic.types.Message(
            id=f"msg_local_{uuid.uuid4().hex[:12]}", type="message", role="assistant", model=body["model"],
            content=[{"type": "text", "text": choice["message"].get("content") or ""}],
            stop_reason="max_tokens" if choice.get("finish_reason") == "length" else "end_turn", stop_sequence=None,
            usage={"input_tokens": usage.get("prompt_tokens", 0), "output_tokens": usage.get("completion_tokens", 0)})


class _Messages:
    """client.messages (or client.beta.messages) with the local model's requests sent to the local server."""

    def __init__(self, remote: Any, local: "LocalModel | None"):
        self._remote, self._local = remote, local

    def create(self, **params: Any) -> Any:
        if self._local and is_local(params.get("model")):
            return self._local.create(params)
        return self._remote.create(**params)

    def stream(self, **params: Any) -> Any:
        if self._local and is_local(params.get("model")):
            return self._local.stream(params)
        return self._remote.stream(**params)

    def count_tokens(self, **params: Any) -> Any:
        if self._local and is_local(params.get("model")):
            return self._local.count_tokens(params)
        return self._remote.count_tokens(**params)

    def __getattr__(self, name: str) -> Any:  # batches and anything else go to Anthropic
        return getattr(self._remote, name)


class _Beta:
    def __init__(self, remote: Any, local: "LocalModel | None"):
        self._remote = remote
        self.messages = _Messages(remote.messages, local)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._remote, name)


class LabClient:
    """An Anthropic client that sends requests for LOCAL_MODEL to the local server. Files, models and everything else
    go to Anthropic as before, so code written for the SDK client works unchanged."""

    def __init__(self, remote: anthropic.Anthropic, local: "LocalModel | None" = None):
        self._remote = remote
        self._local = local or (LocalModel() if LOCAL_MODEL else None)
        self.messages = _Messages(remote.messages, self._local)
        self.beta = _Beta(remote.beta, self._local)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._remote, name)


def local_status(timeout: float = 2.0) -> dict[str, Any]:
    """Whether the local server is up and has the model, for the status page. Never raises."""
    if not LOCAL_MODEL:
        return {"configured": False}
    try:
        r = httpx.get(f"{ENV.local_openai_url}/models", timeout=timeout)
        ids = [m.get("id", "") for m in r.json().get("data", [])]
        found = any(LOCAL_MODEL == i or LOCAL_MODEL.split("/")[-1].lower() == i.split("/")[-1].lower() for i in ids)
        return {"configured": True, "running": True, "has_model": found, "model": LOCAL_MODEL}
    except Exception:
        return {"configured": True, "running": False, "has_model": False, "model": LOCAL_MODEL}
