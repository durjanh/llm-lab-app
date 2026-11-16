"""Model failover: an agent that keeps working when its model is rate limited or overloaded.

The lab owns the conversation. Every step (the user's message, each model call, each tool result, each summary) is written to
a ConversationStore (conversation_store.py) as it happens, and every model call is built from that store, never from
anything a provider holds. So a call can go to a different model, or a different provider, in the middle of a conversation:
the next model sees the same history, including the tool results the last one asked for.

The agent is a tool loop over the invented Northwind handbook (python/data.py). Its tools are search_handbook (read only)
and create_ticket (a write). The loop is a state machine over the stored history: it looks at the last step and does the
next thing (run a missing tool, call the model, or stop). That is why a crash or a failed call resumes from the last whole
step, and why a switch repeats nothing:
  * a model call that fails is not a step; the router (model_router.py) tries the next pool with the same history
  * a tool that has run is a step, so the model never asks for it again after a switch
  * create_ticket carries an idempotency key (conversation, turn, subject), so even a crash between running the tool and
    writing its step cannot make a second ticket

A switch happens only between model calls. Replies are not streamed here: a streamed reply that failed half way would have
to be thrown away before the next model started, and this keeps that simple by only keeping whole replies.

What is sent to a model is built for that model. Thinking blocks are kept in the store but sent only to the model that
wrote them. GPT deployments take the same Claude-shaped request: LabClient translates it with gpt_model.to_chat.

Models. Which models are used, in what order, with what window and (if PRICES does not list them) what price, comes from a
ModelCatalog (model_catalog.py) on every turn: config/model-failover.json or Table Storage. Nothing here names a model.
Compaction. Before each model call the history is measured (an estimate: characters divided by four, plus a ten per cent
margin, because counting by the API is a call that may itself fail in an outage). When it passes the threshold, the smaller
of COMPACT_AT times this model's window and COMPACT_MAX_TOKENS, the older turns are summarised by the compaction model from the catalog (through
the router, so the summary can fail over too) and the summary is stored as a step. From then on the model gets the latest
summary and the last KEEP_RECENT turns word for word. Nothing is deleted: the steps a summary covers stay in the store, and
only what is sent changes. The cut is always between turns, so a tool_use is never parted from its tool_result, and the
summary always ends with a list, written by code, of the write actions already taken, so a summary cannot forget a ticket.
A summary that is empty, refused or cut off is not used; the full history is sent if it still fits, otherwise the turn fails.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from ..core.errors import ApiError, describe
from ..gateways.claude import ClaudeGateway
from .conversation_store import USER, Conflict, ConversationStore, NotFound, Step, key_order
from .history import assistant_blocks, no_reply
from .model_catalog import ModelCatalog
from .model_router import ModelRouter, Pool
from .runs import Run, RunStreamer
from .spend import SpendTracker
from ..shared import PRICES, cost_usd
from data import HANDBOOK_SECTIONS  # noqa: E402  (python/data.py, on the path through shared)
from local_model import without_fallback  # noqa: E402

MAX_ITERATIONS = 6  # the defaults of Limits; MODEL_FAILOVER_MAX_ITERATIONS and the rest in .env change them
MAX_TOKENS = 1024
SUMMARY_MAX_TOKENS = 700
MAX_MESSAGE = 1500
MARGIN = 1.1  # the estimate is padded by this
CHARS_PER_TOKEN = 4
HARD_LIMIT = 0.95  # of a window: above this a request is not sent
log = logging.getLogger("llm_lab")
CLAIM_TTL_S = 900.0
START_GRACE_S = 30.0  # a claim whose work has not begun by then was abandoned (the page left before streaming)
STRIP = {"thinking", "redacted_thinking"}

SYSTEM = ("You are the Northwind HR assistant. Answer questions about the employee handbook. Use search_handbook before you "
          "answer a policy question, and quote the section you used. If the person asks you to raise a ticket, use "
          "create_ticket once, then say the ticket number. Keep answers short.")
SUMMARY_SYSTEM = ("You write the memory of a conversation between an employee and the Northwind HR assistant. Summarise the "
                  "conversation so far in under 250 words: what the person asked, what the handbook said, decisions, and "
                  "anything still open. Plain text, no preamble.")
TOOLS: list[dict[str, Any]] = [
    {"name": "search_handbook", "description": "Search the Northwind employee handbook. Read only.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "create_ticket", "description": "Raise an HR ticket with a short subject. This writes a record: call it once "
     "per request.", "input_schema": {"type": "object", "properties": {"subject": {"type": "string"}},
                                      "required": ["subject"]}},
]
WRITE_TOOLS = {"create_ticket"}
EXAMPLES = ["How many days of annual leave do I get, and can I carry any over?",
            "What is the expenses limit for meals when I travel? Then raise a ticket asking HR to confirm it for my team.",
            "Summarise our sickness absence and parental leave rules."]


@dataclass(frozen=True)
class Compaction:
    """When to compact and how much to keep. The first three can be overridden per conversation."""
    at: float = 0.7
    max_tokens: int = 60000
    keep_recent: int = 4
    model: str = ""  # an override from MODEL_FAILOVER_COMPACT_MODEL; empty means the catalog's compact_model

    @classmethod
    def from_settings(cls, settings: Any) -> "Compaction":
        return cls(settings.model_failover_compact_at, settings.model_failover_compact_max_tokens,
                   settings.model_failover_keep_recent, settings.model_failover_compact_model)

    def with_overrides(self, overrides: dict[str, Any] | None) -> "Compaction":
        o = overrides or {}
        return Compaction(o.get("compact_at", self.at), o.get("compact_max_tokens", self.max_tokens),
                          o.get("keep_recent", self.keep_recent), self.model)

    def threshold(self, window: int) -> int:
        return int(min(self.at * window, self.max_tokens))

    def as_dict(self) -> dict[str, Any]:
        return {"compact_at": self.at, "compact_max_tokens": self.max_tokens, "keep_recent": self.keep_recent,
                "compact_model": self.model}


@dataclass(frozen=True)
class Limits:
    """How long a reply and a summary may be, and how many model calls one turn may make (a safety stop)."""
    max_tokens: int = MAX_TOKENS
    summary_max_tokens: int = SUMMARY_MAX_TOKENS
    max_iterations: int = MAX_ITERATIONS

    @classmethod
    def from_settings(cls, settings: Any) -> "Limits":
        return cls(settings.model_failover_max_tokens, settings.model_failover_summary_max_tokens,
                   settings.model_failover_max_iterations)


def check_overrides(values: dict[str, Any]) -> dict[str, Any]:
    """The overrides if each is in range (compact_at 0.2 to 0.95, compact_max_tokens 4000 or more, keep_recent 1 to 20)."""
    out: dict[str, Any] = {}
    if values.get("compact_at") is not None:
        if not isinstance(values["compact_at"], (int, float)) or not 0.2 <= values["compact_at"] <= 0.95:
            raise ApiError(400, "invalid_request", "compact_at must be between 0.2 and 0.95.")
        out["compact_at"] = float(values["compact_at"])
    if values.get("compact_max_tokens") is not None:
        if not isinstance(values["compact_max_tokens"], int) or not 4000 <= values["compact_max_tokens"] <= 2_000_000:
            raise ApiError(400, "invalid_request", "compact_max_tokens must be 4000 or more.")
        out["compact_max_tokens"] = values["compact_max_tokens"]
    if values.get("keep_recent") is not None:
        if not isinstance(values["keep_recent"], int) or not 1 <= values["keep_recent"] <= 20:
            raise ApiError(400, "invalid_request", "keep_recent must be between 1 and 20.")
        out["keep_recent"] = values["keep_recent"]
    return out


class CompactionFailed(Exception):
    """The summary was empty, refused, cut off or could not be written. History is left as it was."""


# ----- the invented ticket desk -----

class RunCancelled(Exception):
    """The page went: stop before the next model call."""


class TicketDesk:
    """HR's ticket system. create() takes an idempotency key: the same key returns the ticket already made."""

    def __init__(self, path: Path | None = None):
        self.path, self._lock = path, threading.Lock()
        self.tickets: dict[str, dict[str, Any]] = {}
        if path and path.is_file():
            try:
                self.tickets = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                # Writes are atomic, so this is damage from outside. Keep the file for a person to look at rather
                # than overwrite it, and say so: the idempotency keys in it are lost to this run.
                aside = path.with_suffix(path.suffix + ".unreadable")
                os.replace(path, aside)
                log.error("model failover: the ticket file could not be read; moved to %s", aside)
                self.tickets = {}

    def create(self, key: str, subject: str) -> tuple[dict[str, Any], bool]:
        """(ticket, already_existed)."""
        with self._lock:
            if key in self.tickets:
                return self.tickets[key], True
            numbers = [int(t["ticket"].split("-")[1]) for t in self.tickets.values() if t.get("ticket", "").startswith("NW-")]
            ticket = {"ticket": f"NW-{max(numbers, default=1000) + 1}", "subject": subject, "status": "open"}
            self.tickets[key] = ticket
            if self.path:  # write a temporary file and rename it: a crash leaves the old file or the new, never half
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(self.path.suffix + ".tmp")
                tmp.write_text(json.dumps(self.tickets), encoding="utf-8")
                os.replace(tmp, self.path)
            return ticket, False


def search_handbook(query: str) -> list[dict[str, str]]:
    words = {w for w in re.findall(r"[a-z]+", query.lower()) if len(w) > 2}
    scored = sorted(((sum(w in (t + " " + b).lower() for w in words), t, b) for t, b in HANDBOOK_SECTIONS), reverse=True)
    return [{"section": t, "text": b} for score, t, b in scored[:2] if score]


# ----- the history, as plain functions -----

def estimate_tokens(*parts: Any) -> int:
    """Characters over four, plus a ten per cent margin. Offline: it works when the API is the thing that is failing."""
    return math.ceil(len(json.dumps(parts, ensure_ascii=False, default=str)) / CHARS_PER_TOKEN * MARGIN)


def block_text(content: list[dict[str, Any]], limit: int = 400) -> str:
    out = []
    for b in content:
        kind = b.get("type")
        if kind == "text":
            out.append(b.get("text", ""))
        elif kind == "tool_use":
            out.append(f"[called {b.get('name')}({json.dumps(b.get('input', {}))})]")
        elif kind == "tool_result":
            out.append(f"[result: {str(b.get('content', ''))[:limit]}]")
    return " ".join(out)


def latest_summary(steps: list[Step]) -> Step | None:
    return next((s for s in reversed(steps) if s.kind == "summary"), None)


def last_turn_step(steps: list[Step]) -> Step | None:
    """The last step that belongs to a turn. A summary step can come last (Compact now) but is not part of a turn."""
    return next((s for s in reversed(steps) if s.kind != "summary"), None)


def visible(steps: list[Step]) -> tuple[Step | None, list[Step]]:
    """The latest summary and the steps after what it covers: what a model is sent."""
    summary = latest_summary(steps)
    cut = key_order(summary.covers_until) if summary else (-1, -1)
    return summary, [s for s in steps if s.kind != "summary" and (s.turn, s.step) > cut]  # by number: step 100 is after 99


def pending_tool_uses(steps: list[Step]) -> list[dict[str, Any]]:
    """tool_use blocks of the last model step that have no tool_result after them yet."""
    last = next((i for i in range(len(steps) - 1, -1, -1) if steps[i].kind == "model"), None)
    if last is None:
        return []
    done = {b.get("tool_use_id") for s in steps[last + 1:] if s.kind == "tool" for b in s.content}
    return [b for b in steps[last].content if b.get("type") == "tool_use" and b["id"] not in done]


def build_messages(steps: list[Step], target: Pool) -> list[dict[str, Any]]:
    """The conversation as `target` should be sent it: the latest summary and what follows, thinking blocks only for the
    model that wrote them, consecutive messages of one role joined (tool results first)."""
    summary, vis = visible(steps)
    messages: list[dict[str, Any]] = []
    for st in vis:
        blocks = [dict(b) for b in st.content]
        if st.role == "assistant" and st.model != target.model:
            blocks = [b for b in blocks if b.get("type") not in STRIP]
        if not blocks:
            blocks = [{"type": "text", "text": "(no reply)"}]
        if messages and messages[-1]["role"] == st.role:
            messages[-1]["content"] += blocks
            messages[-1]["content"].sort(key=lambda b: b.get("type") != "tool_result")
        else:
            messages.append({"role": st.role, "content": blocks})
    if summary:
        text = {"type": "text", "text": summary.content[0]["text"]}
        if not messages:  # the summary covers everything: it is the whole history, never dropped
            return [{"role": "user", "content": [text]}]
        content = messages[0]["content"]
        messages[0]["content"] = content + [text] if any(b.get("type") == "tool_result" for b in content) else [text] + content
    return messages


def compaction_cut(vis: list[Step], keep: int) -> int | None:
    """Where to cut `vis`: the index of the first step of the oldest turn to keep, or None when there is nothing to
    summarise. It is always the start of a turn (a user step) with every tool_use before it answered, so a tool_use is
    never parted from its tool_result."""
    turns = sorted({s.turn for s in vis})
    if len(turns) <= keep:
        return None
    first = turns[-keep]
    cut = next(i for i, s in enumerate(vis) if s.turn == first)
    head = vis[:cut]
    uses = {b["id"] for s in head if s.kind == "model" for b in s.content if b.get("type") == "tool_use"}
    results = {b.get("tool_use_id") for s in head if s.kind == "tool" for b in s.content}
    if vis[cut].kind != "user" or not uses <= results:
        return None
    return cut


def actions_taken(steps: list[Step]) -> list[str]:
    """The write actions in `steps` that worked, from their results: code lists them so a summary cannot lose one."""
    out = []
    for s in steps:
        if s.kind == "tool" and s.tool in WRITE_TOOLS:
            for b in s.content:
                if not b.get("is_error"):
                    try:
                        d = json.loads(b.get("content", "{}"))
                        out.append(f"{s.tool}: ticket {d['ticket']} \"{d['subject']}\"")
                    except (ValueError, KeyError, TypeError):
                        out.append(f"{s.tool}: done")
    return out


def carried_actions(summary: Step | None) -> list[str]:
    """The actions list of an earlier summary, so repeated compaction never drops one."""
    if summary is None or "Actions already taken" not in summary.content[0]["text"]:
        return []
    tail = summary.content[0]["text"].split("Actions already taken (do not repeat them):\n", 1)[-1]
    return [line[2:] for line in tail.splitlines() if line.startswith("- ")]


def transcript(summary: Step | None, steps: list[Step]) -> str:
    lines = [summary.content[0]["text"]] if summary else []
    for s in steps:
        who = {"user": "Person" if s.kind == "user" else "Tool", "assistant": "Assistant"}[s.role]
        lines.append(f"{who}: {block_text(s.content)}")
    return "\n".join(lines)[-100_000:]


class _Turn:
    """One run's working state: the history as it is now, the ETag to write with, and what it has cost."""

    def __init__(self, svc: "ModelFailoverService", conv_id: str, user_id: str, steps: list[Step], etag: str,
                 cfg: Compaction, primary: str | None, run: Run | None):
        self.svc, self.conv_id, self.user_id, self.steps, self.etag = svc, conv_id, user_id, steps, etag
        self.cfg, self.primary, self.run = cfg, primary, run
        self.cost, self.switches, self.latency_ms = 0.0, 0, 0
        self.compaction_failed = False

    def emit(self, event: dict[str, Any]) -> None:
        if self.run is not None:
            self.run.publish(event)

    @property
    def turn(self) -> int:
        return self.steps[-1].turn if self.steps else 0

    def next_key(self, new_turn: bool = False) -> tuple[int, int]:
        if not self.steps:
            return 0, 0
        last = self.steps[-1]
        return (last.turn + 1, 0) if new_turn else (last.turn, last.step + 1)

    def append(self, step: Step) -> Step:
        self.etag = self.svc.store.append_step(self.conv_id, step, self.etag, self.user_id)
        self.steps.append(step)
        self.emit({"type": "step", "step": step.to_dict()})
        return step

    def on_router(self, event: dict[str, Any]) -> None:
        if event["type"] == "switch":
            self.switches += 1
        self.emit(event)


class ModelFailoverService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, streamer: RunStreamer | None, store: ConversationStore,
                 router: ModelRouter, compaction: Compaction | None = None, desk: TicketDesk | None = None,
                 run_budget_usd: float = 0.25, models: ModelCatalog | None = None, limits: Limits | None = None):
        self.claude, self.spend, self.streamer, self.store, self.router = claude, spend, streamer, store, router
        self.models, self.limits = models, limits or Limits()
        self.compaction, self.desk, self.run_budget_usd = compaction or Compaction(), desk or TicketDesk(), run_budget_usd
        self._claims: dict[str, list[Any]] = {}  # conv -> [claimed at, work started]
        self._now = time.monotonic
        self._claims_lock = threading.Lock()

    # ----- claims: one writer per conversation in this process; the ETag guards the rest -----

    def _held(self, conv_id: str) -> bool:
        """Whether a claim still counts. A streamed turn claims before its stream starts; if the page goes before the
        stream is read, the work never runs and never releases, so an unstarted claim lapses after START_GRACE_S."""
        claim = self._claims.get(conv_id)
        if not claim:
            return False
        age = self._now() - claim[0]
        return age < (CLAIM_TTL_S if claim[1] else START_GRACE_S)

    def _claim(self, conv_id: str, started: bool = True) -> None:
        with self._claims_lock:
            if self._held(conv_id):
                raise ApiError(409, "busy", "This conversation is already being worked on. Wait for it to finish.")
            self._claims[conv_id] = [self._now(), started]

    def _started(self, conv_id: str) -> None:
        with self._claims_lock:
            if conv_id in self._claims:
                self._claims[conv_id][1] = True

    def _release(self, conv_id: str) -> None:
        with self._claims_lock:
            self._claims.pop(conv_id, None)

    def busy(self, conv_id: str) -> bool:
        with self._claims_lock:
            return self._held(conv_id)

    # ----- conversations -----

    def _load(self, conv_id: str):
        try:
            return self.store.load(conv_id, USER)
        except NotFound:
            raise ApiError(404, "not_found", "No such conversation.") from None

    def create_conversation(self) -> dict[str, Any]:
        return self.store.create(USER).summary()

    def list_conversations(self) -> list[dict[str, Any]]:
        return [c.summary() for c in self.store.list(USER)]

    def delete_conversation(self, conv_id: str) -> None:
        if self.busy(conv_id):
            raise ApiError(409, "busy", "This conversation is being worked on.")
        try:
            self.store.delete(conv_id, USER)
        except NotFound:
            raise ApiError(404, "not_found", "No such conversation.") from None

    def defaults(self) -> Compaction:
        """The server's compaction defaults, with the model from the catalog unless an environment override is set."""
        if self.compaction.model or self.models is None:
            return self.compaction
        try:
            return replace(self.compaction, model=self.models.compact_model())
        except Exception:  # noqa: BLE001  (no catalog: the router's first pool writes the summary)
            return self.compaction

    def config(self, overrides: dict[str, Any] | None) -> Compaction:
        return self.defaults().with_overrides(overrides)

    def _compact_primary(self, name: str) -> str | None:
        """The pool that should write a summary: `name` is a pool name or a model id; None when no pool matches."""
        pool = self.router.get(name) or next((p for p in self.router.pools if p.model == name), None)
        return pool.name if pool else None

    # ----- the model list -----

    def _catalog(self) -> ModelCatalog:
        if self.models is None:
            raise ApiError(503, "model_catalog_unavailable", "This server has no model catalog.")
        return self.models

    def catalog(self) -> dict[str, Any]:
        return self._catalog().payload()

    def save_catalog(self, document: dict[str, Any], version: str) -> dict[str, Any]:
        out = self._catalog().save(document, version)
        self.router.sync()  # the next model call uses it; this only makes the answer show it
        return out

    def reload_catalog(self) -> dict[str, Any]:
        out = self._catalog().reload()
        self.router.sync()
        return out

    def primary_pool(self, primary: str | None) -> Pool:
        return self.router.order(primary)[0]

    def memory(self, steps: list[Step], cfg: Compaction, primary: str | None = None) -> dict[str, Any]:
        """Tokens in what would be sent next, against the threshold, and the latest summary."""
        pool = self.primary_pool(primary)
        tokens = estimate_tokens(SYSTEM, TOOLS, build_messages(steps, pool))
        summary = latest_summary(steps)
        return {"model": pool.model, "tokens": tokens, "window": pool.context_tokens,
                "threshold": cfg.threshold(pool.context_tokens), "settings": cfg.as_dict(),
                "defaults": self.defaults().as_dict(),
                "compactions": sum(s.kind == "summary" for s in steps),
                "last": None if summary is None else {
                    "key": summary.key, "covers_from": summary.covers_from, "covers_until": summary.covers_until,
                    "model": summary.model, "created_at": summary.created_at, "text": summary.content[0]["text"]}}

    def get_conversation(self, conv_id: str, primary: str | None = None) -> dict[str, Any]:
        self._check_primary(primary)
        conv = self._load(conv_id)
        cfg = self.config(conv.overrides)
        return {"conversation": {**conv.summary(), "etag": conv.etag, "overrides": conv.overrides},
                "steps": [s.to_dict() for s in conv.steps], "incomplete": self.incomplete(conv.steps),
                "active": self.busy(conv_id), "memory": self.memory(conv.steps, cfg, primary),
                "storage": {**self.store.describe(), **(self.store.rows(conv_id, USER) if hasattr(self.store, "rows") else {})}}

    def set_overrides(self, conv_id: str, values: dict[str, Any]) -> dict[str, Any]:
        overrides = check_overrides(values)
        self._claim(conv_id)
        try:
            conv = self._load(conv_id)
            try:
                self.store.update_meta(conv_id, conv.etag, overrides=overrides, user_id=USER)
            except Conflict:
                raise ApiError(409, "busy", "The conversation changed while its settings were saved.") from None
        finally:
            self._release(conv_id)
        return self.get_conversation(conv_id)

    @staticmethod
    def incomplete(steps: list[Step]) -> bool:
        """A turn is whole when its last step (ignoring summaries, which only change what is sent) is a model reply."""
        last = last_turn_step(steps)
        return last is not None and (last.kind != "model" or bool(pending_tool_uses(steps)))

    def _check_primary(self, primary: str | None) -> None:
        if primary and self.router.get(primary) is None:
            raise ApiError(400, "invalid_request", "primary: choose one of " + ", ".join(p.name for p in self.router.pools))

    def info(self) -> dict[str, Any]:
        return {"router": self.router.status(), "storage": self.store.describe(), "tools": TOOLS, "system": SYSTEM,
                "examples": EXAMPLES, "compaction": self.defaults().as_dict(),
                "limits": {"message": MAX_MESSAGE, "iterations": self.limits.max_iterations,
                           "max_tokens": self.limits.max_tokens, "summary_max_tokens": self.limits.summary_max_tokens,
                           "compact_at": [0.2, 0.95],
                           "compact_max_tokens_min": 4000, "keep_recent": [1, 20]},
                "estimate": f"characters divided by {CHARS_PER_TOKEN}, plus {round((MARGIN - 1) * 100)} per cent margin",
                "handbook": [t for t, _ in HANDBOOK_SECTIONS], "run_budget_usd": self.run_budget_usd}

    # ----- the loop -----

    def _record_model(self, t: _Turn, resp: Any, pool: Pool, routed_from: str, reason: str, ms: int) -> Step:
        blocks = [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in resp.content
                  if getattr(b, "type", None) in STRIP or (isinstance(b, dict) and b.get("type") in STRIP)]
        turn, step = t.next_key()
        return Step(turn, step, "model", "assistant", blocks + assistant_blocks(resp), pool.model, pool.provider,
                    routed_from, reason, getattr(resp, "stop_reason", "") or "", resp.usage.input_tokens,
                    resp.usage.output_tokens, ms)

    def _create(self, t: _Turn, pool: Pool, **params: Any) -> tuple[Any, int]:
        # Checked before every model call, including each retry, switch and compaction the router makes: once the
        # page has gone, nothing more is paid for. The router treats this as a failure and stops at once.
        if t.run is not None and t.run.cancelled.is_set():
            raise RunCancelled()
        started = time.perf_counter()
        with without_fallback():  # the router owns failover: the client must not switch model behind its back
            resp = self.claude.create(model=pool.model, **params)
        ms = round((time.perf_counter() - started) * 1000)
        cost = self.spend.charge(resp, pool.model, pool.price)
        if cost is None:
            # No price for the model that answered (neither in PRICES nor in its catalog entry). A real call was made,
            # so count it at the dearest list price: the run cap and the budget must still trip, never see $0.
            cost = max((cost_usd(resp.usage, m) or 0.0) for m in PRICES)
            self.spend.charge_usd(cost, f"{pool.model}: no price known, counted at the highest list price")
        t.cost += cost
        return resp, ms

    def _prepare(self, t: _Turn, pool: Pool) -> list[dict[str, Any]]:
        """The request's messages for this pool. Over the threshold for this pool's window, the history is compacted first."""
        messages = build_messages(t.steps, pool)
        tokens = estimate_tokens(SYSTEM, TOOLS, messages)
        if tokens > t.cfg.threshold(pool.context_tokens) and not t.compaction_failed:
            if self.compact(t) is not None:
                messages = build_messages(t.steps, pool)
                tokens = estimate_tokens(SYSTEM, TOOLS, messages)
        if tokens > int(pool.context_tokens * HARD_LIMIT):
            raise ApiError(413, "context_too_long",
                           f"The history is about {tokens:,} tokens and {pool.model} takes {pool.context_tokens:,}. "
                           "It could not be shortened, so nothing was sent. Nothing is lost: the history is intact.")
        return messages

    def compact(self, t: _Turn) -> Step | None:
        """Writes a summary step for the older turns, or returns None (nothing to summarise, or the summary failed, in
        which case the history is left as it was). A stale ETag raises Conflict: another request got there first."""
        summary, vis = visible(t.steps)
        cut = compaction_cut(vis, t.cfg.keep_recent)
        if cut is None:
            return None
        covered = vis[:cut]
        try:
            text, pool, ms = self._summarise(t, transcript(summary, covered))
        except (Conflict, RunCancelled):  # not a failed summary: another writer, or the page went
            raise
        except Exception as exc:  # noqa: BLE001  (an unusable summary never replaces the history)
            t.compaction_failed = True
            t.emit({"type": "compaction_failed", "reason": describe(exc) if not isinstance(exc, CompactionFailed) else str(exc)})
            return None
        done = carried_actions(summary) + actions_taken(covered)
        body = f"Summary of the earlier conversation, written by {pool.model}:\n{text}"
        if done:
            body += "\nActions already taken (do not repeat them):\n- " + "\n- ".join(done)
        turn, step = t.next_key()
        record = Step(turn, step, "summary", "user", [{"type": "text", "text": body}], pool.model, pool.provider,
                      latency_ms=ms, covers_from=summary.covers_from if summary else covered[0].key,
                      covers_until=covered[-1].key)
        t.append(record)
        t.emit({"type": "compaction", "step": record.to_dict()})
        return record

    def _summarise(self, t: _Turn, text: str) -> tuple[str, Pool, int]:
        def send(pool: Pool) -> Any:
            return self._create(t, pool, max_tokens=self.limits.summary_max_tokens, system=SUMMARY_SYSTEM,
                                messages=[{"role": "user", "content": [{"type": "text", "text": text}]}])

        routed = self.router.call(send, self._compact_primary(t.cfg.model), t.on_router)
        resp, ms = routed.result
        reply = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
        if resp.stop_reason in ("refusal", "max_tokens") or not reply:
            raise CompactionFailed(f"{routed.pool.model} gave no usable summary (stop_reason {resp.stop_reason}"
                                   f"{', empty' if not reply else ''}).")
        return reply, routed.pool, ms

    def run_tool(self, t: _Turn, use: dict[str, Any]) -> tuple[str, bool]:
        args = use.get("input") or {}
        try:
            if use["name"] == "search_handbook" and isinstance(args.get("query"), str) and args["query"].strip():
                return json.dumps(search_handbook(args["query"][:200])), False
            if use["name"] == "create_ticket" and isinstance(args.get("subject"), str) and args["subject"].strip():
                subject = args["subject"].strip()[:120]
                key = f"{t.conv_id}:{t.turn}:{subject.lower()}"  # the same request in the same turn is the same ticket
                ticket, existed = self.desk.create(key, subject)
                return json.dumps({**ticket, "already_existed": existed}), False
        except Exception as exc:  # noqa: BLE001
            return f"The tool failed: {exc}", True
        return f"Unknown tool or missing input for {use['name']}.", True

    def _run_pending_tools(self, t: _Turn) -> None:
        for use in pending_tool_uses(t.steps):
            text, is_error = self.run_tool(t, use)
            turn, step = t.next_key()
            t.append(Step(turn, step, "tool", "user", [{"type": "tool_result", "tool_use_id": use["id"], "content": text,
                                                         "is_error": is_error}], tool=use["name"]))

    def drive(self, t: _Turn) -> dict[str, Any]:
        """Looks at the last step and does the next thing until the turn is whole. Safe to start from any step."""
        calls = 0
        while True:
            if t.run is not None and t.run.cancelled.is_set():
                return {"stop_reason": "cancelled", "reply": ""}
            if pending_tool_uses(t.steps):
                self._run_pending_tools(t)
                continue
            last = last_turn_step(t.steps)
            if last is not None and last.kind == "model":
                break
            if calls >= self.limits.max_iterations:
                return {"stop_reason": "iteration_cap", "reply": f"(Stopped after {self.limits.max_iterations} model calls.)"}
            if self.spend.over_budget:  # the server's whole budget, not this run's: Resume would be refused too
                raise ApiError(402, "over_budget", "The lab's spending cap is reached. Restart the backend with a higher "
                                                   "--budget to continue; the steps so far are saved.")
            if t.cost >= self.run_budget_usd:
                raise ApiError(400, "run_budget", f"This run reached its ${self.run_budget_usd:.2f} cap. Resume to continue.")
            calls += 1
            try:
                routed = self.router.call(lambda pool: self._send(t, pool), t.primary, t.on_router)
            except RunCancelled:
                return {"stop_reason": "cancelled", "reply": ""}
            resp, ms = routed.result
            step = self._record_model(t, resp, routed.pool, routed.fallback_from, routed.reason, ms)
            t.append(step)
        last = last_turn_step(t.steps)
        reply = block_text([b for b in last.content if b.get("type") == "text"]) or no_reply(last)
        return {"stop_reason": last.stop_reason, "reply": reply, "model": last.model}

    def _send(self, t: _Turn, pool: Pool) -> tuple[Any, int]:
        return self._create(t, pool, max_tokens=self.limits.max_tokens, system=SYSTEM, tools=TOOLS,
                            messages=self._prepare(t, pool))

    # ----- the routes' entry points -----

    def _start(self, conv_id: str, primary: str | None, text: str | None) -> tuple[_Turn, Run]:
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        self._check_primary(primary)
        self._claim(conv_id, started=False)
        try:
            conv = self._load(conv_id)
            run = Run()
            t = _Turn(self, conv_id, conv.user_id, list(conv.steps), conv.etag, self.config(conv.overrides), primary, run)
            self._run_pending_tools(t)  # free and local: finish what a crash left, before anything new is added
            if text is not None:
                turn, step = t.next_key(new_turn=True)
                t.append(Step(turn, step, "user", "user", [{"type": "text", "text": text}]))
            elif not self.incomplete(t.steps):
                raise ApiError(400, "nothing_to_resume", "This conversation is not part way through a turn.")
        except Conflict:
            self._release(conv_id)
            raise ApiError(409, "busy", "Another request changed this conversation first. Reload it and try again.") from None
        except BaseException:
            self._release(conv_id)
            raise
        return t, run

    def _stream(self, t: _Turn, run: Run) -> Iterator[str]:
        def work() -> None:
            status = "idle"
            self._started(t.conv_id)
            try:
                out = self.drive(t)
                run.publish({"type": "done", **out, "cost_usd": round(t.cost, 6), "switches": t.switches,
                             "steps": len(t.steps)})
            except Conflict:
                status = "failed"
                run.publish({"type": "error", "cost_usd": round(t.cost, 6),
                             "message": "Another request changed this conversation first (busy).",
                             "can_resume": False})
            except Exception as exc:  # noqa: BLE001  (an API error part way through: the steps so far are kept)
                status = "failed"
                spent = isinstance(exc, ApiError) and exc.kind == "over_budget"  # Resume would only get a 402
                run.publish({"type": "error", "message": describe(exc), "can_resume": not spent,
                             "cost_usd": round(t.cost, 6)})  # calls made before the error were charged
            finally:
                self._set_status(t, status)
                self._release(t.conv_id)

        return self.streamer.lines(run, work)  # type: ignore[union-attr]

    def _set_status(self, t: _Turn, status: str) -> None:
        """Marks the conversation idle or failed after a turn. Every step written set it to running, so if this fails it
        stays running. A stale ETag (the row changed under us, as after a Conflict) is retried once with a fresh one; this
        process still holds the claim, so no other turn here is writing."""
        try:
            self.store.update_meta(t.conv_id, t.etag, status=status, user_id=USER)
            return
        except Conflict:
            pass
        except Exception:  # noqa: BLE001
            log.exception("Could not mark conversation %s %s.", t.conv_id, status)
            return
        try:
            self.store.update_meta(t.conv_id, self.store.load(t.conv_id, USER).etag, status=status, user_id=USER)
        except Exception:  # noqa: BLE001
            log.exception("Could not mark conversation %s %s.", t.conv_id, status)

    def send(self, conv_id: str, text: str, primary: str | None = None) -> Iterator[str]:
        text = text.strip()
        if not text:  # an empty text block would be refused by the API on every later call, so never store one
            raise ApiError(400, "invalid_request", "message: write something.")
        t, run = self._start(conv_id, primary, text)
        return self._stream(t, run)

    def resume(self, conv_id: str, primary: str | None = None) -> Iterator[str]:
        t, run = self._start(conv_id, primary, None)
        return self._stream(t, run)

    def compact_now(self, conv_id: str, primary: str | None = None) -> dict[str, Any]:
        """For the lab: compact now, whatever the threshold. Two at once: one writes, the other gets 409."""
        self._check_primary(primary)
        self._claim(conv_id)
        try:
            conv = self._load(conv_id)
            t = _Turn(self, conv_id, conv.user_id, list(conv.steps), conv.etag, self.config(conv.overrides), primary, None)
            if pending_tool_uses(t.steps):
                raise ApiError(409, "incomplete", "A tool call in this conversation has no result yet. Resume it first.")
            if compaction_cut(visible(t.steps)[1], t.cfg.keep_recent) is None:
                raise ApiError(400, "nothing_to_compact",
                               f"There is nothing to summarise: no more than {t.cfg.keep_recent} turns are in use.")
            try:
                step = self.compact(t)
            except Conflict:
                raise ApiError(409, "busy", "Another request changed this conversation first.") from None
            if step is None:
                raise ApiError(502, "compaction_failed", "The summary could not be written, so the history is unchanged.")
            try:
                self.store.update_meta(conv_id, t.etag, status=conv.status, user_id=USER)
            except Conflict:
                pass
            return {"step": step.to_dict(), "memory": self.memory(t.steps, t.cfg, primary), "cost_usd": round(t.cost, 6)}
        finally:
            self._release(conv_id)

    # ----- router and faults (free) -----

    def router_status(self) -> dict[str, Any]:
        return self.router.status()

    def inject(self, pool: str, kind: str, count: int) -> dict[str, Any]:
        try:
            self.router.inject(pool, kind, count)
        except ValueError as exc:
            raise ApiError(400, "invalid_request", str(exc)) from None
        return self.router.status()

    def clear_faults(self, pool: str | None) -> dict[str, Any]:
        if pool and self.router.get(pool) is None:
            raise ApiError(400, "invalid_request", f"Unknown pool {pool}.")
        self.router.clear_faults(pool)
        return self.router.status()

    def reset_router(self) -> dict[str, Any]:
        self.router.reset()
        return self.router.status()
