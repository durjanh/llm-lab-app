"""The hotel booking agent in the lab: a guest chats with an agent that books, changes and cancels rooms. It runs on
Claude, a GPT deployment or the local model: one tool loop in Claude's format, which the lab's client translates.

The hotel, its rules and its tools are examples/hotel/hotel.py, shared with the command line. This service keeps the
open conversations, charges each model call, and gives the page the back office: the room calendar, bookings, the
guest's outbox and the audit log. The payment page and the front desk are here too: they are the hotel's other
systems, which change the database without the agent.
"""
from __future__ import annotations

import threading
import uuid
from collections import OrderedDict
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import CLAUDE_MODEL, hotel_rules as rules
from .spend import SpendTracker

MAX_CHATS = 20  # the oldest is dropped when another starts


class HotelService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, db_path: Path, notifier: Any = None,
                 clock: Callable[[], datetime] = datetime.now):
        self.claude, self.spend, self.db_path, self.notifier, self.clock = claude, spend, db_path, notifier, clock
        self._hotel: Any = None
        self.chats: OrderedDict[str, tuple[Any, str]] = OrderedDict()  # chat id -> (rules.Chat, model)
        self._lock = threading.Lock()

    @property
    def hotel(self) -> Any:
        with self._lock:
            if self._hotel is None:
                self._hotel = rules.Hotel(self.db_path, self.clock, self.notifier)
            return self._hotel

    def info(self) -> dict[str, Any]:
        today = self.hotel.today
        return {"hotel": rules.HOTEL, "room_types": list(rules.TYPE.values()),
                "tools": [{"name": t["name"], "description": t["description"]} for t in rules.TOOLS],
                "instructions": rules.instructions(today), "samples": rules.samples(today),
                "today": today.isoformat(), "model": CLAUDE_MODEL,
                "delivery": {"email": "real" if getattr(self.notifier, "email", False) else "outbox",
                             "sms": "real" if getattr(self.notifier, "sms", False) else "outbox"}}

    def board(self) -> dict[str, Any]:
        return self.hotel.board()

    def start(self, model: str | None) -> dict[str, Any]:
        chat_id, hotel = uuid.uuid4().hex, self.hotel  # read before taking the lock: the property takes it too
        with self._lock:
            self.chats[chat_id] = (rules.Chat(hotel), model or CLAUDE_MODEL)
            while len(self.chats) > MAX_CHATS:
                self.chats.popitem(last=False)
        return {"chat_id": chat_id, "model": self.chats[chat_id][1]}

    def message(self, chat_id: str, text: str) -> dict[str, Any]:
        found = self.chats.get(chat_id)
        if found is None:
            raise ApiError(404, "not_found", "That conversation has ended. Start a new one.")
        chat, model = found
        screened, removed = chat.guest_says(text)
        cost = 0.0

        def charge(response: Any) -> None:
            nonlocal cost
            cost += self.spend.charge(response, model) or 0.0

        try:
            reply, steps = rules.claude_turn(self.claude.create, chat, model, screened, on_response=charge)
        except ApiError:
            raise
        except Exception as exc:
            raise to_api_error(exc) from exc
        return {"reply": reply, "steps": steps, "screened": {"text": screened, "redactions": removed},
                "cost_usd": round(cost, 6), "payment_links": chat.payment_links, "board": self.board()}

    def pay(self, token: str) -> dict[str, Any]:
        return {**self.hotel.pay(token), "board": self.board()}

    def front_desk(self, type_code: str, check_in: str, check_out: str) -> dict[str, Any]:
        try:
            ci, co = date.fromisoformat(check_in), date.fromisoformat(check_out)
        except ValueError:
            raise ApiError(400, "invalid_request", "Dates must be YYYY-MM-DD.") from None
        return {**self.hotel.front_desk(type_code, ci, co), "board": self.board()}

    def reset(self) -> dict[str, Any]:
        """A fresh hotel: the database is made again and every conversation ends."""
        with self._lock:
            if self._hotel is not None:
                self._hotel.db.close()
                self._hotel = None
            self.db_path.unlink(missing_ok=True)
            self.chats.clear()
        return {"board": self.board()}
