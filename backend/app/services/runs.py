"""Live runs: work that happens in a background thread and reports its progress as a stream of events.

A Run is the channel between the worker and the page: the worker publishes events to it, and a
command that needs a person waits on it until the page answers. The RunRegistry keeps the runs in
progress so an answer from the page can find its run.
"""
from __future__ import annotations

import json
import queue
import threading
import uuid
from collections.abc import Callable, Iterator
from typing import Any

from ..core.errors import describe


class Run:
    def __init__(self, approval_timeout_s: float = 120.0):
        self.id = uuid.uuid4().hex
        self.approval_timeout_s = approval_timeout_s
        self.cancelled = threading.Event()
        self._events: queue.Queue[dict | None] = queue.Queue()
        self._waiting: dict[str, dict] = {}  # tool_use_id -> {"answered": Event, "allow": bool}
        self._lock = threading.Lock()

    def publish(self, event: dict | None) -> None:
        """Sends an event to the page. None marks the end of the run."""
        self._events.put(event)

    def next_event(self, timeout: float) -> dict | None:
        """The next event, or raises queue.Empty after `timeout` seconds."""
        return self._events.get(timeout=timeout)

    def ask(self, block: Any, who: str, depth: int, reason: str) -> bool:
        """A permission prompt answered on the page. Unanswered, cancelled or denied means no."""
        waiter = {"answered": threading.Event(), "allow": False}
        with self._lock:
            self._waiting[block.id] = waiter
        self.publish({"type": "approval", "who": who, "depth": depth, "id": block.id, "name": block.name,
                      "input": block.input, "reason": reason, "timeout_s": self.approval_timeout_s})
        answered = waiter["answered"].wait(self.approval_timeout_s)
        with self._lock:
            self._waiting.pop(block.id, None)
        allow = answered and waiter["allow"] and not self.cancelled.is_set()
        self.publish({"type": "approval_done", "id": block.id, "allow": allow, "timed_out": not answered})
        return allow

    def answer(self, tool_use_id: str, allow: bool) -> bool:
        """Records the page's answer. False when nothing with that id is waiting."""
        with self._lock:
            waiter = self._waiting.get(tool_use_id)
        if waiter is None:
            return False
        waiter["allow"] = allow
        waiter["answered"].set()
        return True

    def cancel(self) -> None:
        """The page went away: stop the work and refuse every command still waiting."""
        self.cancelled.set()
        with self._lock:
            for waiter in self._waiting.values():
                waiter["answered"].set()


class RunRegistry:
    """The runs in progress, by id."""

    def __init__(self) -> None:
        self._runs: dict[str, Run] = {}
        self._lock = threading.Lock()

    def add(self, run: Run) -> None:
        with self._lock:
            self._runs[run.id] = run

    def get(self, run_id: str) -> Run | None:
        with self._lock:
            return self._runs.get(run_id)

    def remove(self, run_id: str) -> None:
        with self._lock:
            self._runs.pop(run_id, None)

    def end_all(self) -> int:
        """The server is stopping: cancel every run and end its stream now, not at the next heartbeat."""
        with self._lock:
            runs = list(self._runs.values())
        for run in runs:
            run.cancel()
            run.publish(None)
        return len(runs)


class RunStreamer:
    """Starts a run's work in a thread and turns its events into newline-delimited JSON for the page."""

    def __init__(self, registry: RunRegistry, heartbeat_s: float):
        self.registry, self.heartbeat_s = registry, heartbeat_s

    def lines(self, run: Run, work: Callable[[], None]) -> Iterator[str]:
        def worker() -> None:
            try:
                work()
            except Exception as exc:  # anything unexpected still reaches the page
                run.publish({"type": "error", "message": describe(exc)})
            finally:
                run.publish(None)

        self.registry.add(run)
        threading.Thread(target=worker, daemon=True).start()
        try:
            yield json.dumps({"type": "run", "run_id": run.id}) + "\n"
            while True:
                try:
                    event = run.next_event(self.heartbeat_s)
                except queue.Empty:
                    yield "\n"  # writing fails once the page has gone, which ends this loop
                    continue
                if event is None:
                    break
                yield json.dumps(event, default=str) + "\n"
        finally:
            run.cancel()
            self.registry.remove(run.id)
