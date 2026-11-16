"""Model failover on Microsoft Agent Framework (1.23): a chat client that falls back, and a history provider that keeps the
conversation in the lab's own Blob + Table layout.

FallbackChatClient wraps two or more chat clients (for example Claude on Anthropic, then a GPT deployment on Azure OpenAI)
and implements the chat client protocol (get_response), so an Agent uses it like any other client. A call goes to the first
client whose circuit breaker allows it; failures are classified by shared/rules.py: a short 429 is retried once, a long 429,
a 529, a 5xx or a timeout opens the breaker and switches, a 400/401/403/404 is raised. Switching happens between calls only:
the next client gets the same messages, because the Agent gets its history from the provider, not from a client.

BlobTableHistoryProvider is a HistoryProvider (get_messages, save_messages) over shared/lab_store.py, so the conversation is
in Blob (one JSON document per step) with a Table index, not in a provider's thread. get_messages also compacts: over the
threshold (MODEL_FAILOVER_COMPACT_AT of the window, or MODEL_FAILOVER_COMPACT_MAX_TOKENS) it summarises the older turns with the
summary client, stores the summary as a step, and returns [summary, the last MODEL_FAILOVER_KEEP_RECENT turns]. The steps
stay in the store. An empty, refused or cut-off summary is ignored and the full history is returned.

AgentSession.to_dict() then holds only the session id: nothing about the conversation lives in it.
"""
from __future__ import annotations

import asyncio
import sys
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from agent_framework import BaseChatClient, ChatResponse, Content, HistoryProvider, Message

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "shared"))
import lab_store  # noqa: E402
from rules import (CircuitBreaker, CompactSettings, Fault, classify, compaction_cut, estimate_tokens,  # noqa: E402
                   usable_summary)

Event = Callable[[dict[str, Any]], None]


class FailoverExhausted(RuntimeError):
    """Every client was open or failed."""


class FallbackChatClient(BaseChatClient):
    """Tries its clients in order. `clients` is a list of (name, chat client)."""

    def __init__(self, clients: Sequence[tuple[str, Any]], cooldown_s: float = 30.0, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep, on_event: Event | None = None):
        super().__init__()
        self.clients = list(clients)
        self.breakers = {name: CircuitBreaker(cooldown_s, clock) for name, _ in clients}
        self._sleep, self.on_event = sleep, on_event or (lambda e: None)
        self.last_model = ""

    def _inner_get_response(self, *, messages: Sequence[Message], stream: bool, options: Mapping[str, Any], **kwargs: Any):
        if stream:
            raise NotImplementedError("A stream cannot be moved to another model half way: call get_response without "
                                      "stream, or buffer the stream and throw partial output away on a failure.")
        return self._call(messages, options, kwargs)

    async def _call(self, messages: Sequence[Message], options: Mapping[str, Any], kwargs: dict[str, Any]) -> ChatResponse:
        tried: list[str] = []
        first = ""
        for name, client in self.clients:
            breaker = self.breakers[name]
            if not breaker.allow():
                tried.append(f"{name}: breaker {breaker.state}")
                first = first or name
                continue
            retried = False
            while True:
                try:
                    response = await client.get_response(messages, options=options)
                except Exception as exc:  # noqa: BLE001
                    verdict = classify(exc)
                    if verdict.action == "fail":
                        breaker.release()
                        raise
                    if verdict.action == "retry" and not retried:
                        retried = True
                        self.on_event({"type": "retry", "client": name, "reason": verdict.reason})
                        await self._sleep(verdict.retry_after or 0)
                        continue
                    breaker.failure(verdict.retry_after)
                    tried.append(f"{name}: {verdict.reason}")
                    first = first or name
                    self.on_event({"type": "switch", "from": name, "reason": verdict.reason})
                    break
                breaker.success()
                self.last_model = name
                if first and first != name:
                    response.additional_properties["fallback_from"] = first
                return response
        raise FailoverExhausted("No model answered: " + "; ".join(tried))


class InjectFaults:
    """Wraps a chat client so its next calls fail with a given status, before anything is sent (free). For demos and tests."""

    def __init__(self, client: Any, faults: list[tuple[int | None, float | None]]):
        self.client, self.faults = client, list(faults)

    async def get_response(self, messages: Sequence[Message], **kwargs: Any) -> ChatResponse:
        if self.faults:
            raise Fault(*self.faults.pop(0))
        return await self.client.get_response(messages, **kwargs)


class ClaudeChatClient(BaseChatClient):
    """A small text-only chat client for Claude on the Anthropic API (agent-framework-anthropic needs a newer core than 1.23)."""

    def __init__(self, model: str, client: Any = None, max_tokens: int = 600):
        super().__init__()
        self.model, self.max_tokens = model, max_tokens
        self._client = client

    def _inner_get_response(self, *, messages: Sequence[Message], stream: bool, options: Mapping[str, Any], **kwargs: Any):
        if stream:
            raise NotImplementedError("Text-only example client: no streaming.")
        return self._call(messages, options)

    async def _call(self, messages: Sequence[Message], options: Mapping[str, Any]) -> ChatResponse:
        import anthropic
        client = self._client or anthropic.Anthropic()
        system = "\n".join(m.text for m in messages if m.role == "system" and m.text)
        turns: list[dict[str, Any]] = []
        for m in messages:
            if m.role in ("user", "assistant") and m.text:
                if turns and turns[-1]["role"] == m.role:
                    turns[-1]["content"] += "\n" + m.text
                else:
                    turns.append({"role": m.role, "content": m.text})
        params: dict[str, Any] = {"model": self.model, "max_tokens": self.max_tokens, "messages": turns}
        if system:
            params["system"] = system
        reply = await asyncio.to_thread(lambda: client.messages.create(**params))
        text = "".join(b.text for b in reply.content if b.type == "text")
        return ChatResponse(messages=[Message("assistant", [Content.from_text(text)])], model=self.model,
                            finish_reason={"end_turn": "stop", "max_tokens": "length", "refusal": "content_filter"}.get(reply.stop_reason, "stop"))


# ----- history -----

def _blocks(message: Message) -> list[dict[str, Any]]:
    """Canonical blocks: a text mirror for reading and compaction, and the framework's own message so it restores exactly."""
    blocks: list[dict[str, Any]] = [{"type": "text", "text": message.text or ""}]
    blocks.append({"type": "af_message", "data": message.to_dict()})
    return blocks


def _message(step: Any) -> Message:
    raw = next((b for b in step.content if b.get("type") == "af_message"), None)
    return Message.from_dict(raw["data"]) if raw else Message(step.role, [Content.from_text(step.content[0].get("text", ""))])


class BlobTableHistoryProvider(HistoryProvider):
    """The conversation of record, in the lab's Blob + Table layout. session_id is the conversation (hashed to the lab's id)."""

    def __init__(self, store: Any, summariser: Any | None = None, settings: CompactSettings | None = None,
                 window: int = 200_000, user: str = "lab", source_id: str = "blob-table-history"):
        super().__init__(source_id)
        self.store, self.summariser, self.settings = store, summariser, settings or CompactSettings.from_env()
        self.window, self.user = window, user
        self.events: list[dict[str, Any]] = []

    def _conv(self, session_id: str | None) -> str:
        conv_id = lab_store.conv_id_for(session_id or "default")
        lab_store.ensure(self.store, conv_id, self.user)
        return conv_id

    async def save_messages(self, session_id: str | None, messages: Sequence[Message], *, state: dict[str, Any] | None = None,
                            **kwargs: Any) -> None:
        conv_id = self._conv(session_id)
        conv = self.store.load(conv_id, self.user)
        etag, last = conv.etag, (conv.steps[-1] if conv.steps else None)
        for m in messages:
            if last is None:
                turn, step = 0, 0
            elif m.role == "user":
                turn, step = last.turn + 1, 0  # a user message starts a turn
            else:
                turn, step = last.turn, last.step + 1
            kind = "user" if m.role == "user" else "tool" if m.role == "tool" else "model"
            record = lab_store.Step(turn, step, kind, "assistant" if kind == "model" else "user", _blocks(m))
            etag = self.store.append_step(conv_id, record, etag, self.user)
            last = record

    async def get_messages(self, session_id: str | None, *, state: dict[str, Any] | None = None, **kwargs: Any) -> list[Message]:
        conv_id = self._conv(session_id)
        conv = self.store.load(conv_id, self.user)
        steps = conv.steps
        summary = next((s for s in reversed(steps) if s.kind == "summary"), None)
        visible = [s for s in steps if s.kind != "summary" and s.key > (summary.covers_until if summary else "")]
        text = "\n".join(s.content[0].get("text", "") for s in visible)
        if self.summariser is not None and estimate_tokens(text) > self.settings.threshold(self.window):
            cut = compaction_cut([s.turn for s in visible], self.settings.keep_recent)
            if cut:  # None, or 0 (nothing before the first turn)
                summary = await self._compact(conv, summary, visible[:cut]) or summary
                visible = [s for s in visible if summary is None or s.key > summary.covers_until]
        out = [Message("user", [Content.from_text(summary.content[0]["text"])])] if summary else []
        return out + [_message(s) for s in visible]

    async def _compact(self, conv: Any, previous: Any, covered: list[Any]) -> Any | None:
        transcript = "\n".join(([previous.content[0]["text"]] if previous else [])
                               + [f"{s.role}: {s.content[0].get('text', '')}" for s in covered])
        try:
            response = await self.summariser.get_response([
                Message("system", [Content.from_text("Summarise this conversation in under 200 words: questions, answers, "
                                                       "decisions, anything open. Plain text.")]),
                Message("user", [Content.from_text(transcript)])])
        except Exception as exc:  # noqa: BLE001  (no summary: the full history is used)
            self.events.append({"type": "compaction_failed", "reason": type(exc).__name__})
            return None
        if not usable_summary(response.text, response.finish_reason):
            self.events.append({"type": "compaction_failed", "reason": f"empty, refused or cut off ({response.finish_reason})"})
            return None
        last = conv.steps[-1]
        body = f"Summary of the earlier conversation:\n{response.text.strip()}"
        record = lab_store.Step(last.turn, last.step + 1, "summary", "user", [{"type": "text", "text": body}],
                                model=response.model or "", covers_from=previous.covers_from if previous else covered[0].key,
                                covers_until=covered[-1].key)
        try:
            self.store.append_step(conv.id, record, conv.etag, self.user)  # the ETag: two compactors cannot both write
        except lab_store.Conflict:
            self.events.append({"type": "compaction_skipped", "reason": "another writer got there first"})
            return None
        self.events.append({"type": "compaction", "covers": [record.covers_from, record.covers_until]})
        return record
