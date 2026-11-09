"""The /workflows page's routes against a fake runner: no Azure, no cost."""
from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.gateways import agent_workflows
from backend.app.main import create_app
from backend.app.services.workflows import PATTERNS
from backend.app.settings import Settings

LAB = {"x-llm-lab": "1", "host": "localhost:8000"}
EXAMPLES = Path(__file__).resolve().parents[2] / "examples" / "agent-framework" / "workflows"


class FakeRunner:
    model = "gpt-5.4-mini"

    def __init__(self, calls: int = 1, question: bool = False):
        self.calls, self.question = calls, question
        self.answers: list[bool] = []
        self.stopped: str | None = None

    def run(self, pattern: str, task: str | None, *, emit: Any, ask: Any, stop: Any, on_usage: Any) -> None:
        emit({"type": "step", "node": pattern, "state": "start", "text": task or ""})
        if self.question:
            self.answers.append(ask("r1", "Send these?"))
        for _ in range(self.calls):
            self.stopped = stop()
            if self.stopped:
                return
            on_usage(1000, 1000)


def lab(runner: Any, budget: float = 1.0) -> TestClient:
    settings = Settings(budget_usd=budget, run_budget_usd=0.01)
    return TestClient(create_app(settings, client=object(), workflows=runner))


def lines(response: Any) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def test_the_list_of_patterns_matches_the_example_files() -> None:
    assert sorted(PATTERNS) == sorted(p.stem[3:] for p in EXAMPLES.glob("[0-9][0-9]_*.py"))


def test_a_run_streams_its_events_and_charges_each_model_call() -> None:
    with lab(FakeRunner(calls=2)) as client:
        events = lines(client.post("/api/workflows/run", json={"pattern": "concurrent", "task": "Hello"}, headers=LAB))
        status = client.app.state.container.spend
    assert [e["type"] for e in events] == ["run", "step", "final"]
    assert events[1]["node"] == "concurrent" and events[1]["text"] == "Hello"
    assert events[2]["input_tokens"] == 2000 and events[2]["cost_usd"] == pytest.approx(0.0105)  # gpt-5.4-mini: 0.75 and 4.50
    assert status.spent_usd == pytest.approx(0.0105)


def test_a_run_stops_at_its_own_budget() -> None:
    runner = FakeRunner(calls=50)
    with lab(runner) as client:
        client.post("/api/workflows/run", json={"pattern": "magentic"}, headers=LAB)
    assert "reached its" in runner.stopped


def test_an_unknown_pattern_is_refused() -> None:
    with lab(FakeRunner()) as client:
        response = client.post("/api/workflows/run", json={"pattern": "nonsense"}, headers=LAB)
    assert response.status_code == 400


def test_a_run_needs_azure_settings() -> None:
    with lab(None) as client:
        response = client.post("/api/workflows/run", json={"pattern": "sequential"}, headers=LAB)
    assert response.status_code == 503


def test_the_routes_need_the_lab_page() -> None:
    with lab(FakeRunner()) as client:
        response = client.post("/api/workflows/run", json={"pattern": "sequential"}, headers={"host": "localhost:8000"})
    assert response.status_code == 403


def test_a_workflow_waits_for_a_person_and_gets_the_answer() -> None:
    runner = FakeRunner(question=True)
    seen: list[dict] = []
    with lab(runner) as client:
        def answer_when_asked() -> None:
            container = client.app.state.container
            for _ in range(200):
                runs = list(getattr(container.runs, "_runs", {}).values())
                if runs and runs[0].answer("r1", True):
                    return
                threading.Event().wait(0.01)

        threading.Thread(target=answer_when_asked, daemon=True).start()
        seen = lines(client.post("/api/workflows/run", json={"pattern": "plan_approve_run"}, headers=LAB))
    assert runner.answers == [True]
    assert "approval" in [e["type"] for e in seen] and seen[-1]["type"] == "final"


def test_the_yaml_workflow_needs_its_own_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(agent_workflows, "EXAMPLES", tmp_path)
    with pytest.raises(ApiError) as caught:
        agent_workflows.AgentWorkflows("https://x", "gpt-5.4-mini").run(
            "declarative", None, emit=print, ask=lambda *_: True, stop=lambda: None, on_usage=lambda *_: None)
    assert caught.value.status == 503 and "requirements-declarative" in caught.value.message


SCRIPT = """print('Patch applied by the .NET loader')
print('@@{"type": "step", "node": "classify", "state": "start", "text": ""}', flush=True)
print('@@{"type": "tokens", "input": 10, "output": 5}', flush=True)
"""


def test_a_subprocess_reports_its_events_and_tokens_and_its_own_noise_is_ignored() -> None:
    events: list[dict] = []
    usage: list[tuple[int, int]] = []
    agent_workflows.read_lines([sys.executable, "-c", SCRIPT], events.append, lambda: None, lambda i, o: usage.append((i, o)))
    assert [e["node"] for e in events] == ["classify"] and usage == [(10, 5)]


def test_a_subprocess_that_fails_is_reported() -> None:
    with pytest.raises(ApiError):
        agent_workflows.read_lines([sys.executable, "-c", "print('boom'); raise SystemExit(1)"], print, lambda: None, lambda *_: None)
