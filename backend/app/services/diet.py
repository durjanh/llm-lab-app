"""The diet planner in the lab: a person chats with an agent that asks a few questions, designs a week of meals and
remembers them between conversations. It runs on Claude, a GPT deployment or the local model.

The targets, checks, tools and files are examples/diet/diet.py, shared with the command line. This service keeps the
open conversations, charges each model call, and serves the checked plan as files and the person's memory folder.
"""
from __future__ import annotations

import shutil
import threading
import uuid
from collections import OrderedDict
from datetime import date
from pathlib import Path
from typing import Any, Callable, Iterator

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import CLAUDE_MODEL, diet_rules as rules
from .runs import Run, RunStreamer
from .spend import SpendTracker

MAX_CHATS = 20  # the oldest is dropped when another starts


class DietService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, memory_root: Path,
                 streamer: RunStreamer | None = None, today: Callable[[], date] = date.today):
        self.claude, self.spend, self.memory_root, self.today = claude, spend, memory_root, today
        self.streamer = streamer
        self.chats: OrderedDict[str, tuple[Any, str]] = OrderedDict()  # chat id -> (rules.Chat, model)
        self._lock = threading.Lock()

    def info(self) -> dict[str, Any]:
        return {"tools": [{"name": t["name"], "description": t["description"]} for t in rules.TOOLS],
                "samples": rules.samples(), "model": CLAUDE_MODEL, "floors": rules.FLOOR,
                "files": {k: v[0] for k, v in rules.FILES.items()}}

    def start(self, model: str | None, user: str, consent: bool) -> dict[str, Any]:
        chat = rules.new_chat(self.memory_root, user, consent)
        chat_id = uuid.uuid4().hex
        with self._lock:
            self.chats[chat_id] = (chat, model or CLAUDE_MODEL)
            while len(self.chats) > MAX_CHATS:
                self.chats.popitem(last=False)
        return {"chat_id": chat_id, "model": model or CLAUDE_MODEL, "user": chat.user, "consent": consent,
                "memory": self.memory(chat.user)}

    def _chat(self, chat_id: str) -> tuple[Any, str]:
        found = self.chats.get(chat_id)
        if found is None:
            raise ApiError(404, "not_found", "That conversation has ended. Start a new one.")
        return found

    def message(self, chat_id: str, text: str) -> dict[str, Any]:
        chat, model = self._chat(chat_id)
        cost = 0.0

        def charge(response: Any) -> None:
            nonlocal cost
            cost += self.spend.charge(response, model) or 0.0

        try:
            reply, steps = rules.diet_turn(self.claude.create, chat, model, text, today=self.today(),
                                           on_response=charge)
        except ApiError:
            raise
        except Exception as exc:
            raise to_api_error(exc) from exc
        return {"reply": reply, "steps": steps, "cost_usd": round(cost, 6), **self.state(chat)}

    def stream_message(self, chat_id: str, text: str) -> Iterator[str]:
        """The same turn as message(), streamed as NDJSON: the planner's words as they are written, each tool call as
        it starts and finishes, how much of the week has been written, then the reply and the plan."""
        chat, model = self._chat(chat_id)
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        run = Run()

        def work() -> None:
            cost = 0.0

            def charge(response: Any) -> None:
                nonlocal cost
                cost += self.spend.charge(response, model) or 0.0

            try:
                reply, steps = rules.diet_turn(self.claude.create, chat, model, text, today=self.today(),
                                               on_response=charge, stream=self.claude.stream, emit=run.publish)
            except ApiError as exc:
                run.publish({"type": "error", "message": exc.message})
                return
            except Exception as exc:
                err = to_api_error(exc)
                run.publish({"type": "error", "message": err.message})
                return
            run.publish({"type": "done", "reply": reply, "steps": steps, "cost_usd": round(cost, 6), **self.state(chat)})

        return self.streamer.lines(run, work)

    def state(self, chat: Any) -> dict[str, Any]:
        """What the page shows beside the chat: the profile, the targets, the checked plan and the memory folder."""
        plan = chat.plan
        return {"profile": chat.profile, "targets": chat.targets, "plan": plan,
                "totals": rules.daily_totals(plan) if plan else None,
                "shopping": rules.shopping_list(plan) if plan else None,
                "aisles": rules.AISLE_NAMES, "memory": self.memory(chat.user)}

    def file(self, chat_id: str, kind: str) -> tuple[bytes, str, str]:
        chat, _ = self._chat(chat_id)
        if kind not in rules.FILES:
            raise ApiError(404, "not_found", "Choose plan, shopping or xlsx.")
        if not chat.plan:
            raise ApiError(409, "no_plan", "There is no plan yet. Finish the conversation first.")
        name, media, make = rules.FILES[kind]
        return make(chat), name, media

    def memory(self, user: str) -> list[dict[str, str]]:
        root = self.memory_root / rules.safe_user(user)
        if not root.exists():
            return []
        return [{"path": "/memories/" + f.relative_to(root).as_posix(), "text": f.read_text()}
                for f in sorted(root.rglob("*")) if f.is_file() and not f.is_symlink()]

    def forget(self, user: str) -> dict[str, Any]:
        """Deletes everything remembered about this person."""
        shutil.rmtree(self.memory_root / rules.safe_user(user), ignore_errors=True)
        return {"memory": []}
