"""MedAssist in the lab: a patient portal chat with the Foundry prompt agent from examples/medassist.

The agent runs in Microsoft Foundry. Its function tools run here, against the example's dummy practice database,
through the same tool loop and rules as the example's command line (clinic.py): the signed-in patient is fixed
by the portal, a slot is booked only after the patient has seen it, and cancelling takes two turns. Each model
response is charged to the spend tracker; File Search and Code Interpreter sessions have their own Azure charges,
which are not counted here.
"""
from __future__ import annotations

import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ..core.errors import ApiError
from ..gateways.foundry_agent import AgentConversations
from ..shared import medassist_clinic as clinic
from .spend import SpendTracker

MAX_CONVERSATIONS = 20  # the oldest is ended when another starts
MAX_ROUNDS = 6


@dataclass
class Chat:
    conversation: str  # Foundry's conversation id; the page only sees our own id
    session: Any  # clinic.Session: the signed-in patient, and what they have been shown
    cost_usd: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)


class MedAssistService:
    def __init__(self, agent: AgentConversations | None, spend: SpendTracker, db_path: Path):
        self.agent, self.spend, self.db_path = agent, spend, db_path
        self.chats: OrderedDict[str, Chat] = OrderedDict()
        self._lock = threading.Lock()

    def _agent(self) -> AgentConversations:
        if self.agent is None:
            raise ApiError(503, "not_configured", "Set FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_MODEL in .env, run az login, "
                                                  "and restart the backend.")
        return self.agent

    def _database(self) -> Path:
        if not self.db_path.exists():
            clinic.create_database(self.db_path)
        return self.db_path

    def info(self) -> dict[str, Any]:
        version, problem = None, ""
        if self.agent is not None:
            try:
                version = self.agent.version()
            except ApiError as exc:
                problem = exc.message
        return {"ready": self.agent is not None and version is not None, "configured": self.agent is not None,
                "model": self.agent.model if self.agent else None, "agent": "MedAssist", "version": version,
                "problem": problem, "patients": [{"id": p[0], "name": p[1]} for p in clinic.PATIENTS]}

    def start(self, patient_id: str) -> dict[str, Any]:
        agent = self._agent()
        session = clinic.Session(self._database(), patient_id) if patient_id in {p[0] for p in clinic.PATIENTS} else None
        if session is None:
            raise ApiError(400, "invalid_request", f"patient_id: choose one of {', '.join(p[0] for p in clinic.PATIENTS)}")
        chat = Chat(agent.start(clinic.portal_note(session)), session)
        chat_id = uuid.uuid4().hex
        with self._lock:
            self.chats[chat_id] = chat
            while len(self.chats) > MAX_CONVERSATIONS:
                _, old = self.chats.popitem(last=False)
                agent.end(old.conversation)
        return {"chat_id": chat_id, "state": clinic.snapshot(self.db_path, patient_id)}

    def _chat(self, chat_id: str) -> Chat:
        chat = self.chats.get(chat_id)
        if chat is None:
            raise ApiError(404, "not_found", "That conversation has ended. Start a new one.")
        return chat

    def charge(self, chat: Chat, response: Any) -> None:
        """One model response, at the Foundry model's price. Responses' input count includes the cached tokens."""
        u = getattr(response, "usage", None)
        if u is None:
            return
        cached = getattr(getattr(u, "input_tokens_details", None), "cached_tokens", 0) or 0
        usage = SimpleNamespace(input_tokens=u.input_tokens - cached, cache_read_input_tokens=cached,
                                cache_creation_input_tokens=0, output_tokens=u.output_tokens)
        chat.cost_usd += self.spend.charge(SimpleNamespace(usage=usage), self._agent().model) or 0.0

    def message(self, chat_id: str, text: str) -> dict[str, Any]:
        agent, chat = self._agent(), self._chat(chat_id)
        if not chat.lock.acquire(blocking=False):  # one message at a time: tools depend on the turn order
            raise ApiError(409, "busy", "MedAssist is still answering the last message.")
        try:
            before = chat.cost_usd

            def respond(input: Any) -> Any:
                response = agent.respond(chat.conversation, input)
                self.charge(chat, response)
                return response

            reply, steps = clinic.run_turn(respond, chat.session, text, MAX_ROUNDS)
        finally:
            chat.lock.release()
        return {"reply": reply, "steps": steps, "cost_usd": round(chat.cost_usd - before, 5),
                "total_usd": round(chat.cost_usd, 5), "state": clinic.snapshot(self.db_path, chat.session.patient_id)}

    def end(self, chat_id: str) -> dict[str, Any]:
        with self._lock:
            chat = self.chats.pop(chat_id, None)
        if chat is not None and self.agent is not None:
            self.agent.end(chat.conversation)
        return {"ended": chat is not None}

    def state(self, patient_id: str) -> dict[str, Any]:
        try:
            return clinic.snapshot(self._database(), patient_id)
        except ValueError as exc:
            raise ApiError(404, "not_found", str(exc)) from exc

    def reset(self) -> dict[str, Any]:
        """A fresh practice database. Open conversations end, because the slots they were shown are gone."""
        with self._lock:
            chats, self.chats = list(self.chats.values()), OrderedDict()
        for chat in chats:
            if self.agent is not None:
                self.agent.end(chat.conversation)
        clinic.create_database(self.db_path)
        return {"reset": True, "weeks": clinic.WEEKS_AHEAD}
