"""Aftercare in the lab: post-discharge follow-up calls by a Claude agent or a Microsoft Agent Framework agent.

Both engines get the same instructions and tools from examples/aftercare/ward.py, and every tool runs against
the same hospital record under the same rules. Claude's tool loop is ours (ward.claude_turn); Agent Framework
runs its own on the Foundry model. The page plays the patient, or lets a simulated patient (Claude Haiku) answer,
and the evaluation runs all eight scripted patients and checks what each call left in the record.
"""
from __future__ import annotations

import threading
import uuid
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.agent_framework import FrameworkAgents
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, aftercare_ward as ward
from .runs import Run, RunStreamer
from .spend import SpendTracker

ENGINES = ("claude", "agent-framework")
MAX_CALLS = 20  # the oldest is dropped when another starts
MAX_TURNS = 14  # patient messages in one simulated call
PATIENT_MODEL = DEFAULT_MODEL  # the simulated patient is not what is being tested


@dataclass
class Live:
    call: Any  # ward.Call
    engine: str
    model: str
    agent: Any = None  # Agent Framework's agent and session
    steps: list[dict] = field(default_factory=list)  # Agent Framework's tool calls, as they happen
    cost_usd: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)


class AftercareService:
    def __init__(self, claude: ClaudeGateway, agents: FrameworkAgents | None, spend: SpendTracker,
                 streamer: RunStreamer, db_path: Path):
        self.claude, self.agents, self.spend, self.streamer, self.db_path = claude, agents, spend, streamer, db_path
        self.calls: OrderedDict[str, Live] = OrderedDict()
        self._lock = threading.Lock()

    def _database(self) -> Path:
        if not self.db_path.exists():
            ward.create_database(self.db_path)
        return self.db_path

    def info(self) -> dict[str, Any]:
        path = self._database()
        return {"hospital": ward.HOSPITAL, "engines": {
                    "claude": {"available": True, "model": DEFAULT_MODEL},
                    "agent-framework": {"available": self.agents is not None,
                                        "model": self.agents.model if self.agents else None}},
                "voice_from_age": ward.VOICE_FROM_AGE, "wave_2_from_day": ward.WAVE_2_FROM_DAY,
                "worklist": ward.worklist(path), "queue": ward.queue(path), "hints": ward.HINTS,
                "tools": [{"name": t["name"], "description": t["description"]} for t in ward.TOOLS],
                "instructions": ward.INSTRUCTIONS}

    # ----- one turn, on either engine -----
    def _charge_claude(self, live: Live, response: Any, model: str) -> None:
        live.cost_usd += self.spend.charge(response, model) or 0.0

    def _charge_framework(self, live: Live, usage: dict) -> None:
        cached = usage.get("cache_read_input_token_count") or 0
        u = SimpleNamespace(input_tokens=(usage.get("input_token_count") or 0) - cached, cache_read_input_tokens=cached,
                            cache_creation_input_tokens=0, output_tokens=usage.get("output_token_count") or 0)
        live.cost_usd += self.spend.charge(SimpleNamespace(usage=u), live.model) or 0.0

    def _turn(self, live: Live, text: str) -> tuple[str, list[dict]]:
        """The agent's reply to one input (the opening note, or a screened patient message)."""
        if live.engine == "claude":
            try:
                return ward.claude_turn(self.claude.create, live.call, live.model, text,
                                        on_response=lambda r: self._charge_claude(live, r, live.model))
            except ApiError:
                raise
            except Exception as exc:
                raise to_api_error(exc) from exc
        start = len(live.steps)
        reply, usage = self.agents.respond(live.agent, text)
        self._charge_framework(live, usage)
        return reply, live.steps[start:]

    def _simulated(self, live: Live) -> str:
        try:
            return ward.simulate_patient(self.claude.create, live.call, PATIENT_MODEL,
                                         on_response=lambda r: self._charge_claude(live, r, PATIENT_MODEL))
        except Exception as exc:
            raise to_api_error(exc) from exc

    def _live(self, path: Path, patient_id: str, engine: str, model: str | None) -> Live:
        if engine not in ENGINES:
            raise ApiError(400, "invalid_request", f"engine: choose one of {', '.join(ENGINES)}")
        if patient_id not in ward.BY_ID:
            raise ApiError(404, "not_found", f"No patient {patient_id}.")
        if engine == "agent-framework" and self.agents is None:
            raise ApiError(503, "not_configured", "Set FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_MODEL in .env, run az login, "
                                                  "and restart the backend.")
        live = Live(ward.Call(path, patient_id, engine=engine), engine,
                    (model or DEFAULT_MODEL) if engine == "claude" else self.agents.model)
        if engine == "agent-framework":
            def run_tool(name: str, args: dict) -> dict:
                result = live.call.call(name, args)
                live.steps.append({"tool": name, "args": args, "result": result})
                return result
            live.agent = self.agents.start("Aftercare", ward.INSTRUCTIONS, ward.TOOLS, run_tool)
        return live

    def _reply(self, live: Live, before: float, **extra: Any) -> dict[str, Any]:
        return {**extra, "done": live.call.done, "cost_usd": round(live.cost_usd - before, 5),
                "total_usd": round(live.cost_usd, 5), "spent_usd": round(self.spend.spent_usd, 4),
                "checklist_left": live.call.remaining(), "record": ward.record(live.call.path, live.call.patient_id)}

    # ----- calls from the page -----
    def start(self, patient_id: str, engine: str, model: str | None) -> dict[str, Any]:
        live = self._live(self._database(), patient_id, engine, model)
        reply, steps = self._turn(live, live.call.opening_note())
        call_id = uuid.uuid4().hex
        with self._lock:
            self.calls[call_id] = live
            while len(self.calls) > MAX_CALLS:
                self._stop(self.calls.popitem(last=False)[1])
        return self._reply(live, 0.0, call_id=call_id, engine=engine, model=live.model, wave=live.call.wave,
                           channel=live.call.patient["channel"], reply=live.call.agent_output(reply), steps=steps)

    def _get(self, call_id: str) -> Live:
        live = self.calls.get(call_id)
        if live is None:
            raise ApiError(404, "not_found", "That call has ended. Start a new one.")
        if live.call.done:
            raise ApiError(409, "finished", "That call is finished. Start a new one.")
        return live

    def message(self, call_id: str, text: str, simulate: bool = False) -> dict[str, Any]:
        """The patient's message (typed on the page, or from the simulated patient) and the agent's reply."""
        live = self._get(call_id)
        if not live.lock.acquire(blocking=False):  # one message at a time: the rules depend on the turn order
            raise ApiError(409, "busy", "The agent is still answering the last message.")
        try:
            before = live.cost_usd
            said = self._simulated(live) if simulate else text
            reply, steps = self._turn(live, live.call.patient_input(said))
            return self._reply(live, before, patient=said, reply=live.call.agent_output(reply), steps=steps)
        finally:
            live.lock.release()

    def _stop(self, live: Live) -> None:
        """A call left open is marked stopped, so the worklist does not show it in progress for ever."""
        if not live.call.done:
            live.call.db.execute("UPDATE outreach SET status = 'stopped', finished_at = ? WHERE id = ? AND status = 'in_progress'",
                                 (ward.now(), live.call.outreach))
            live.call.db.commit()

    def end(self, call_id: str) -> dict[str, Any]:
        with self._lock:
            live = self.calls.pop(call_id, None)
        if live is not None:
            self._stop(live)
        return {"ended": live is not None}

    def record(self, patient_id: str) -> dict[str, Any]:
        try:
            return ward.record(self._database(), patient_id)
        except ValueError as exc:
            raise ApiError(404, "not_found", str(exc)) from exc

    def board(self) -> dict[str, Any]:
        path = self._database()
        return {"worklist": ward.worklist(path), "queue": ward.queue(path)}

    def close_task(self, task_id: int, note: str) -> dict[str, Any]:
        if not ward.close_task(self._database(), task_id, note):
            raise ApiError(404, "not_found", "No open task with that id.")
        return self.board()

    def reset(self) -> dict[str, Any]:
        with self._lock:
            self.calls.clear()
        ward.create_database(self.db_path)
        return self.board()

    # ----- the evaluation -----
    def evaluate(self, engine: str, model: str | None, patients: list[str]) -> Iterator[str]:
        """Every scripted patient through a whole call, on a separate copy of the hospital, streamed as it goes."""
        path = self.db_path.parent / "evaluation.db"
        if engine == "agent-framework" and self.agents is None:
            raise ApiError(503, "not_configured", "Set FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_MODEL in .env, run az login, "
                                                  "and restart the backend.")
        run = Run()

        def work() -> None:
            ward.create_database(path)
            passed = total = 0
            cost = 0.0
            for pid in patients:
                if run.cancelled.is_set():
                    return
                if self.spend.over_budget:
                    run.publish({"type": "error", "message": "The spending cap is reached, so the evaluation stopped."})
                    return
                live = self._live(path, pid, engine, model)
                run.publish({"type": "patient", "patient_id": pid, "name": live.call.patient["name"],
                             "wave": live.call.wave, "channel": live.call.patient["channel"]})

                def event(e: dict) -> None:
                    if run.cancelled.is_set():
                        raise ApiError(499, "cancelled", "The page went away.")
                    run.publish({"type": "turn", "patient_id": pid, **e})

                checks = ward.play(live.call, lambda text: self._turn(live, text), lambda c: self._simulated(live),
                                   MAX_TURNS, on_event=event)
                passed += sum(c["passed"] for c in checks)
                total += len(checks)
                cost += live.cost_usd
                run.publish({"type": "result", "patient_id": pid, "checks": checks, "status": ward.record(path, pid)["outreach"][0]["status"],
                             "turns": live.call.turn, "cost_usd": round(live.cost_usd, 5)})
            run.publish({"type": "done", "passed": passed, "total": total, "cost_usd": round(cost, 5),
                         "engine": engine, "model": (model or DEFAULT_MODEL) if engine == "claude" else self.agents.model,
                         "spent_usd": round(self.spend.spent_usd, 4)})

        return self.streamer.lines(run, work)
