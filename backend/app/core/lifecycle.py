"""What runs with the app: services with background work to start when the server starts and to stop when it stops.
The container lists them (`Container.lifecycle`) and the app's lifespan starts and stops them all, so adding one
needs no new code in main.py."""
from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass
from typing import Any, Callable

log = logging.getLogger("backend")


@dataclass(frozen=True)
class Hook:
    """A service's start and stop. Either may be missing; both run in a thread, so they may block."""

    name: str
    start: Callable[[], Any] | None = None
    stop: Callable[[], Any] | None = None


async def start_all(hooks: list[Hook]) -> None:
    for hook in hooks:
        if hook.start:
            await asyncio.to_thread(hook.start)


async def stop_all(hooks: list[Hook], timeout_s: float) -> None:
    """Stops every service side by side, waiting at most `timeout_s` in all. One that fails, or is still stopping
    when the time is up, is logged and left; the rest still stop, and the server goes on shutting down. Each stop
    runs in a daemon thread of its own, not the event loop's thread pool, whose threads the process waits for at
    exit: a stop that hangs cannot hold the server up after this returns."""
    loop = asyncio.get_running_loop()
    waiting: dict[asyncio.Future[None], str] = {}
    for hook in hooks:
        if hook.stop:
            future: asyncio.Future[None] = loop.create_future()
            threading.Thread(target=_run, args=(hook.stop, loop, future), name=f"stop {hook.name}",
                             daemon=True).start()
            waiting[future] = hook.name
    if not waiting:
        return
    done, pending = await asyncio.wait(waiting, timeout=timeout_s)
    for future in pending:
        future.cancel()
        log.warning("%s was still stopping after %g s; the server stops without waiting for it.", waiting[future],
                    timeout_s)
    for future in done:
        if (exc := future.exception()) is not None:
            log.warning("%s did not stop cleanly: %s: %s", waiting[future], type(exc).__name__, exc)


def _run(stop: Callable[[], Any], loop: asyncio.AbstractEventLoop, future: asyncio.Future[None]) -> None:
    """Runs one stop and reports how it ended to the waiting loop (unless the loop has given up on it)."""
    try:
        stop()
    except BaseException as exc:  # noqa: BLE001  (reported, not raised: this thread is the stop's own)
        outcome = exc
    else:
        outcome = None

    def settle() -> None:
        if not future.done():
            future.set_exception(outcome) if outcome else future.set_result(None)
    try:
        loop.call_soon_threadsafe(settle)
    except RuntimeError:  # the loop closed while this stop was still running
        pass
