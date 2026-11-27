"""core/lifecycle.py: every service with background work starts with the app and stops with it, side by side, within
one time limit, and one that fails or overruns does not keep the others running."""
from __future__ import annotations

import asyncio
import threading
import time

from backend.app.core.lifecycle import Hook, start_all, stop_all


def test_every_hook_starts_in_order_and_stops_within_the_time_limit(caplog):
    events: list[str] = []
    release = threading.Event()

    def slow_stop() -> None:
        release.wait(5)  # still stopping when the time is up

    def failing_stop() -> None:
        raise RuntimeError("could not close")
    hooks = [Hook("first", start=lambda: events.append("start first"), stop=lambda: events.append("stop first")),
             Hook("slow", stop=slow_stop), Hook("broken", stop=failing_stop),
             Hook("last", start=lambda: events.append("start last"), stop=lambda: events.append("stop last"))]
    asyncio.run(start_all(hooks))
    assert events == ["start first", "start last"]
    started = time.monotonic()
    asyncio.run(stop_all(hooks, 0.3))
    release.set()
    assert time.monotonic() - started < 2  # the slow one did not hold the server up
    assert {"stop first", "stop last"} <= set(events)
    assert "slow was still stopping" in caplog.text and "broken did not stop cleanly" in caplog.text


def test_the_containers_hooks_cover_runs_the_shop_and_voice(tmp_path):
    from backend.app.main import create_app
    from backend.app.settings import Settings
    from backend.tests.test_assistant import Fake

    app = create_app(Settings(port=8000, budget_usd=1.0, frontend_dist=tmp_path, models_dir=tmp_path / "none",
                              sites_dir=tmp_path / "sites", casework_dir=tmp_path / "casework",
                              generated_dir=tmp_path / "generated"), client=Fake([]))
    names = [h.name for h in app.state.container.lifecycle()]
    assert names[0] == "Runs in progress" and any("shop" in n for n in names) and names[-1] == "Voice replies"
