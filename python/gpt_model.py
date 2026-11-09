"""Runs Messages API requests on a GPT deployment in Azure OpenAI, so a page or script can choose GPT wherever it can
choose Claude.

Requests and replies keep Claude's shapes. The conversation, tools, images and JSON schemas are translated to Chat
Completions, and the reply comes back as an Anthropic SDK Message; a streamed reply comes back as Claude's stream events
(text deltas, and a tool call's input as JSON deltas), so a page that shows a file as it is written works unchanged.
The sign-in is your Azure login (Entra), with no keys. What only Anthropic runs is refused, as for the local model.

GPT models reason before answering. A request's output_config effort sets reasoning_effort (low unless the request asks
for more or for thinking), and the reasoning tokens are allowed for on top of max_tokens, so a short answer is not cut
off by its own reasoning.
"""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from typing import Any, Iterator

import anthropic

from local_model import ModelUnavailable, NeedsClaude, _check, _field, _system_text, _thinking_wanted
from settings import ENV

EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}
REASONING_ALLOWANCE = {"low": 2048, "medium": 8192, "high": 16384}  # tokens of reasoning allowed beyond max_tokens
STOP_REASONS = {"tool_calls": "tool_use", "stop": "end_turn", "length": "max_tokens", "content_filter": "refusal"}


def _block(kind: str, **fields: Any) -> dict:
    return {"type": kind, **fields}


def _image_part(source: Any) -> dict | None:
    kind = _field(source, "type")
    if kind == "base64":
        return {"type": "image_url",
                "image_url": {"url": f"data:{_field(source, 'media_type')};base64,{_field(source, 'data')}"}}
    if kind == "url":
        return {"type": "image_url", "image_url": {"url": _field(source, "url")}}
    return None


def _result_text(content: Any) -> tuple[str, list[dict]]:
    """A tool result's text, and its images as Chat Completions parts (a tool message can carry text only)."""
    if content is None:
        return "", []
    if isinstance(content, str):
        return content, []
    texts, images = [], []
    for b in content:
        if _field(b, "type") == "text":
            texts.append(_field(b, "text") or "")
        elif _field(b, "type") == "image" and (part := _image_part(_field(b, "source"))):
            images.append(part)
    return "\n".join(texts), images


def to_chat(params: dict) -> list[dict]:
    """Claude's system prompt and messages as Chat Completions messages."""
    out: list[dict] = []
    system = _system_text(params.get("system"))
    if system:
        out.append({"role": "system", "content": system})
    for m in params.get("messages") or []:
        role, content = _field(m, "role"), _field(m, "content")
        if isinstance(content, str):
            out.append({"role": role, "content": content})
            continue
        if role == "assistant":
            text = "".join(_field(b, "text") or "" for b in content if _field(b, "type") == "text")
            calls = [{"id": _field(b, "id"), "type": "function",
                      "function": {"name": _field(b, "name"), "arguments": json.dumps(_field(b, "input") or {})}}
                     for b in content if _field(b, "type") == "tool_use"]
            out.append({"role": "assistant", "content": text or None, **({"tool_calls": calls} if calls else {})})
            continue
        parts, images = [], []
        for b in content:
            kind = _field(b, "type")
            if kind == "tool_result":  # each answers one call, straight after the assistant message that made it
                text, pictures = _result_text(_field(b, "content"))
                if _field(b, "is_error"):
                    text = f"Error: {text}"
                out.append({"role": "tool", "tool_call_id": _field(b, "tool_use_id"), "content": text or "(no output)"})
                images += pictures
            elif kind == "text":
                parts.append({"type": "text", "text": _field(b, "text")})
            elif kind == "image" and (part := _image_part(_field(b, "source"))):
                parts.append(part)
        if images:
            parts = [{"type": "text", "text": "The images returned by the tool calls above, in order:"}, *images, *parts]
        if parts:
            out.append({"role": "user", "content": parts})
    return out


def _children(schema: dict) -> Iterator[Any]:
    for key in ("properties", "$defs", "definitions"):
        yield from (schema.get(key) or {}).values()
    for key in ("items", "anyOf", "oneOf", "allOf"):
        value = schema.get(key)
        yield from value if isinstance(value, list) else [value] if isinstance(value, dict) else []


def _strict_ok(schema: Any) -> bool:
    """Whether OpenAI's strict mode accepts the schema: every object closed, with all its properties required."""
    if not isinstance(schema, dict):
        return True
    if schema.get("type") == "object" or "properties" in schema:
        props = schema.get("properties") or {}
        if schema.get("additionalProperties") is not False or set(schema.get("required") or []) != set(props):
            return False
    return all(_strict_ok(child) for child in _children(schema))


def _tool_choice(choice: Any) -> Any:
    kind = _field(choice, "type")
    if kind == "any":
        return "required"
    if kind == "tool":
        return {"type": "function", "function": {"name": _field(choice, "name")}}
    return kind if kind in ("auto", "none") else None


def to_request(params: dict) -> dict:
    """The Chat Completions request for a Messages API request. Raises NeedsClaude for what only Claude can do."""
    model = params["model"]
    _check(params, f"{model} runs in Azure OpenAI and")
    config = params.get("output_config") or {}
    effort = EFFORT.get(config.get("effort") or "", "medium" if _thinking_wanted(params) else "low")
    body: dict[str, Any] = {"model": model, "messages": to_chat(params), "reasoning_effort": effort,
                            "max_completion_tokens": params.get("max_tokens", 4096) + REASONING_ALLOWANCE[effort]}
    tools = params.get("tools") or []
    if tools:
        body["tools"] = [{"type": "function", "function": {
            "name": _field(t, "name"), "description": _field(t, "description") or "",
            "parameters": _field(t, "input_schema") or {"type": "object", "properties": {}},
            **({"strict": True} if _field(t, "strict") and _strict_ok(_field(t, "input_schema")) else {})}}
            for t in tools]
        choice = params.get("tool_choice")
        if choice is not None:
            if (mapped := _tool_choice(choice)) is not None:
                body["tool_choice"] = mapped
            if _field(choice, "disable_parallel_tool_use"):
                body["parallel_tool_calls"] = False
    fmt = config.get("format") or {}
    if fmt.get("type") == "json_schema":
        schema = fmt.get("schema") or {}
        body["response_format"] = {"type": "json_schema",
                                   "json_schema": {"name": "reply", "schema": schema, "strict": _strict_ok(schema)}}
    # temperature, top_p and stop_sequences are left out: reasoning models refuse them.
    return body


def _usage(usage: Any) -> dict:
    if usage is None:
        return {"input_tokens": 0, "output_tokens": 0}
    cached = getattr(getattr(usage, "prompt_tokens_details", None), "cached_tokens", 0) or 0
    return {"input_tokens": usage.prompt_tokens - cached, "output_tokens": usage.completion_tokens,
            "cache_read_input_tokens": cached, "cache_creation_input_tokens": 0}


def _message(model: str, blocks: list[dict], stop: str, usage: Any) -> anthropic.types.Message:
    return anthropic.types.Message(id=f"msg_gpt_{uuid.uuid4().hex[:12]}", type="message", role="assistant", model=model,
                                   content=blocks, stop_reason=stop, stop_sequence=None, usage=_usage(usage))


def _arguments(text: str) -> dict:
    try:
        value = json.loads(text or "{}")
    except ValueError:
        return {"_unreadable_arguments": text}  # the tool then reports the fields it is missing
    return value if isinstance(value, dict) else {}


def from_chat(r: Any, model: str) -> anthropic.types.Message:
    """A Chat Completions reply as an Anthropic Message."""
    choice = r.choices[0]
    msg = choice.message
    blocks = [_block("text", text=msg.content or msg.refusal)] if (msg.content or getattr(msg, "refusal", None)) else []
    for call in msg.tool_calls or []:
        blocks.append(_block("tool_use", id=call.id, name=call.function.name, input=_arguments(call.function.arguments)))
    stop = STOP_REASONS.get(choice.finish_reason, "end_turn")
    if getattr(msg, "refusal", None):
        stop = "refusal"
    elif any(b["type"] == "tool_use" for b in blocks):
        stop = "tool_use"
    return _message(model, blocks, stop, r.usage)


def _event(kind: str, **fields: Any) -> SimpleNamespace:
    return SimpleNamespace(type=kind, **fields)


class GptStream:
    """messages.stream() for GPT: iterating gives Claude's stream events; text_stream and get_final_message() work too."""

    def __init__(self, gpt: "GptModel", params: dict):
        self._gpt, self._model, self._body = gpt, params["model"], to_request(params)
        self._chunks: Any = None
        self._events: Iterator[SimpleNamespace] | None = None
        self._final: anthropic.types.Message | None = None

    def __enter__(self) -> "GptStream":
        self._chunks = self._gpt._call(self._body | {"stream": True, "stream_options": {"include_usage": True}})
        self._events = self._run()
        return self

    def __exit__(self, *exc: Any) -> None:
        close = getattr(self._chunks, "close", None)
        if close:
            close()

    def __iter__(self) -> Iterator[SimpleNamespace]:
        return self._events

    @property
    def text_stream(self) -> Iterator[str]:
        for e in self._events:
            if e.type == "content_block_delta" and e.delta.type == "text_delta":
                yield e.delta.text

    def get_final_message(self) -> anthropic.types.Message:
        for _ in self._events:
            pass
        return self._final

    def until_done(self) -> None:
        self.get_final_message()

    def _run(self) -> Iterator[SimpleNamespace]:
        blocks: list[dict] = []
        args: dict[int, str] = {}   # block index -> the tool call's arguments so far
        calls: dict[int, int] = {}  # Chat Completions tool call index -> block index
        open_block: int | None = None
        finish, usage, refused = None, None, False

        def close() -> Iterator[SimpleNamespace]:
            nonlocal open_block
            if open_block is not None:
                yield _event("content_block_stop", index=open_block)
                open_block = None

        yield _event("message_start", message=SimpleNamespace(id="", model=self._model, role="assistant", content=[]))
        try:
            for chunk in self._chunks:
                usage = chunk.usage or usage
                for choice in chunk.choices or []:
                    delta = choice.delta
                    text = delta.content or getattr(delta, "refusal", None)
                    if getattr(delta, "refusal", None):
                        refused = True
                    if text:
                        if open_block is None or blocks[open_block]["type"] != "text":
                            yield from close()
                            blocks.append(_block("text", text=""))
                            open_block = len(blocks) - 1
                            yield _event("content_block_start", index=open_block,
                                         content_block=SimpleNamespace(type="text", text=""))
                        blocks[open_block]["text"] += text
                        yield _event("content_block_delta", index=open_block, delta=SimpleNamespace(type="text_delta", text=text))
                    for tc in delta.tool_calls or []:
                        if tc.index not in calls:
                            yield from close()
                            blocks.append(_block("tool_use", id=tc.id or f"call_{uuid.uuid4().hex[:12]}",
                                                 name=tc.function.name if tc.function else "", input={}))
                            open_block = calls[tc.index] = len(blocks) - 1
                            args[open_block] = ""
                            b = blocks[open_block]
                            yield _event("content_block_start", index=open_block,
                                         content_block=SimpleNamespace(type="tool_use", id=b["id"], name=b["name"], input={}))
                        piece = tc.function.arguments if tc.function else None
                        if piece:
                            i = calls[tc.index]
                            args[i] += piece
                            yield _event("content_block_delta", index=i,
                                         delta=SimpleNamespace(type="input_json_delta", partial_json=piece))
                    finish = choice.finish_reason or finish
        except Exception as exc:
            raise self._gpt._translate(exc) from exc
        yield from close()
        for i, text in args.items():
            blocks[i]["input"] = _arguments(text)
        stop = "refusal" if refused else STOP_REASONS.get(finish or "stop", "end_turn")
        if stop != "refusal" and any(b["type"] == "tool_use" for b in blocks):
            stop = "tool_use"
        self._final = _message(self._model, blocks, stop, usage)
        yield _event("message_delta", delta=SimpleNamespace(stop_reason=stop, stop_sequence=None), usage=self._final.usage)
        yield _event("message_stop")


class GptModel:
    """A GPT deployment in Azure OpenAI, called through its v1 Chat Completions API with an Entra token."""

    def __init__(self, endpoint: str = ENV.azure_openai_endpoint, client: Any = None):
        self.endpoint = endpoint.rstrip("/")
        self._client = client  # made on first use, so a lab without Azure never signs in

    @property
    def client(self) -> Any:
        if self._client is None:
            from azure.identity import DefaultAzureCredential, get_bearer_token_provider
            from openai import OpenAI
            token = get_bearer_token_provider(DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default")
            self._client = OpenAI(base_url=f"{self.endpoint}/openai/v1/", api_key=token, timeout=600.0, max_retries=2)
        return self._client

    def _translate(self, exc: Exception) -> Exception:
        """An Azure or OpenAI failure as the error the lab already handles."""
        import openai
        from azure.core.exceptions import ClientAuthenticationError
        if isinstance(exc, ClientAuthenticationError) or type(exc).__name__ == "CredentialUnavailableError":
            return ModelUnavailable("Could not sign in to Azure OpenAI with your Azure login. Run az login, or choose "
                                    "another model.")
        if isinstance(exc, openai.APIConnectionError):
            return ModelUnavailable(f"Azure OpenAI is not answering at {self.endpoint}. Choose another model, or try again.")
        if isinstance(exc, openai.APIStatusError):
            return anthropic.APIStatusError(f"Azure OpenAI: {exc.message}", response=exc.response, body=exc.body)
        return exc

    def _call(self, body: dict) -> Any:
        try:
            return self.client.chat.completions.create(**body)
        except Exception as exc:
            raise self._translate(exc) from exc

    def create(self, params: dict) -> anthropic.types.Message:
        body = to_request(params)
        return from_chat(self._call(body), body["model"])

    def stream(self, params: dict) -> GptStream:
        return GptStream(self, params)

    def count_tokens(self, params: dict) -> Any:
        raise NeedsClaude(f"{params.get('model')} runs in Azure OpenAI, which cannot count a request's tokens before it is "
                          "sent. Choose a Claude model for this.")
