"""Monitoring: the call log, the timing wrapper round the client, and the summary the page shows. A fake client, so no
network and no cost."""
from __future__ import annotations

import contextvars
import json
import threading
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.core import telemetry
from backend.app.core.telemetry import CallLog, TimedClient, route_shape
from backend.app.main import create_app
from backend.app.services.observability import percentile, totals, traces
from backend.app.services.runs import Run, RunRegistry, RunStreamer
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import HELLO, LAB, FakeClient, make_client, message
from backend.tests.test_whiteboard import SINE


@pytest.fixture
def fake() -> FakeClient:
    return FakeClient()


def test_a_route_is_logged_by_its_shape_not_its_ids() -> None:
    assert route_shape("/api/diet/chats/3f9a0c1b2d4e5f60718293a4b5c6d7e8/stream") == ("diet", "/diet/chats/{id}/stream")
    assert route_shape("/api/whiteboard/ask") == ("whiteboard", "/whiteboard/ask")
    assert route_shape("/api/diet/memory/durjan") == ("diet", "/diet/memory/{id}")  # a person's name is not kept
    assert route_shape("/assets/app.js") == ("background", "")


def test_percentiles_are_nearest_rank() -> None:
    values = [100.0, 200.0, 300.0, 400.0, 500.0, 600.0, 700.0, 800.0, 900.0, 1000.0]
    assert percentile(values, 50) == 500 and percentile(values, 95) == 1000 and percentile([7.0], 95) == 7
    assert percentile([], 50) is None


def test_the_client_wrapper_times_calls_and_records_failures() -> None:
    log, fake = CallLog(), FakeClient()
    client = TimedClient(fake, log)
    spend = SpendTracker(1.0, log)
    spend.charge(client.messages.create(model="claude-haiku-5-5", max_tokens=5, messages=[]), "claude-haiku-5-5")
    with client.beta.messages.stream(model="claude-haiku-5-5", max_tokens=5, messages=[]) as stream:
        final = stream.get_final_message()
    spend.charge(final, "claude-haiku-5-5")
    spend.charge(message("claude-haiku-5-5"), "claude-haiku-5-5")  # a reply the wrapper never saw: no latency

    def boom(**params: Any) -> Any:
        raise TimeoutError("too slow")

    fake.messages.create = boom  # type: ignore[method-assign]
    with pytest.raises(TimeoutError):
        client.messages.create(model="claude-sonnet-5-5", max_tokens=5, messages=[])
    assert client.models.retrieve("x") == {"id": "x"}  # everything else passes straight through

    created, streamed, untimed, failed = log.calls()
    assert (created["kind"], streamed["kind"], untimed["kind"], failed["kind"]) == ("create", "stream", "untimed", "create")
    assert created["latency_ms"] is not None and streamed["latency_ms"] is not None and untimed["latency_ms"] is None
    assert created["input_tokens"] == 1000 and created["output_tokens"] == 200
    assert created["cost_usd"] == pytest.approx((1000 * 0.10 + 200 * 0.50) / 1e6)
    assert failed["status"] == "error" and failed["error"] == "TimeoutError" and failed["model"] == "claude-sonnet-5-5"
    assert not any(k in created for k in ("messages", "system", "content", "text"))  # counts and timings only
    assert spend.calls == 3 and totals(log.calls())["errors"] == 1 and totals(log.calls())["timed"] == 2


def test_a_reply_from_another_model_is_a_fallback_and_a_dollar_charge_is_kept() -> None:
    log = CallLog()
    spend = SpendTracker(1.0, log)
    spend.charge(message("claude-haiku-5-5"), "claude-sonnet-5-5")  # asked Sonnet, Haiku answered
    spend.charge_usd(0.002, "Azure Language")
    fell_back, service = log.calls()
    assert fell_back["fallback"] and fell_back["asked"] == "claude-sonnet-5-5" and fell_back["model"] == "claude-haiku-5-5"
    assert service["kind"] == "service" and service["model"] == "Azure Language" and service["cost_usd"] == 0.002
    assert totals(log.calls())["fallbacks"] == 1


def test_the_log_is_bounded_and_survives_a_restart(tmp_path: Path) -> None:
    first = CallLog(tmp_path / "calls.jsonl", limit=5)
    path = first.path  # conftest moves every test's log under its own temporary folder
    assert path is not None
    for i in range(12):
        first.add(kind="create", status="ok", n=i)
    assert [c["n"] for c in first.calls()] == [7, 8, 9, 10, 11]
    assert len(path.read_text().splitlines()) <= 10  # the file is cut back once it reaches twice the limit
    again = CallLog(path, limit=5)
    assert [c["n"] for c in again.calls()] == [7, 8, 9, 10, 11] and again.run != first.run
    again.clear()
    assert again.calls() == [] and not path.exists()


def test_a_run_s_worker_keeps_the_request_s_area_and_trace() -> None:
    seen: dict[str, str] = {}

    def start() -> None:
        telemetry._area.set("diet")
        telemetry._trace.set("trace-1")
        list(RunStreamer(RunRegistry(), 0.05).lines(Run(), lambda: seen.update(telemetry.current())))

    thread = threading.Thread(target=contextvars.Context().run, args=(start,))
    thread.start()
    thread.join()
    assert seen["area"] == "diet" and seen["trace"] == "trace-1"


def test_traces_put_one_request_s_calls_in_order() -> None:
    base = {"status": "ok", "fallback": False, "input_tokens": 10, "output_tokens": 5, "cache_read_tokens": 0,
            "cost_usd": 0.001, "area": "diet", "route": "POST /diet/chats/{id}/stream", "model": "m", "kind": "stream"}
    calls = [{**base, "id": "b", "trace": "t1", "at": 105.0, "started": 103.0, "latency_ms": 2000},
             {**base, "id": "a", "trace": "t1", "at": 102.5, "started": 100.0, "latency_ms": 2500},
             {**base, "id": "c", "trace": "t2", "at": 200.0, "started": None, "latency_ms": None}]
    newest, older = traces(calls)
    assert newest["trace"] == "t2" and newest["duration_ms"] == 0
    assert older["duration_ms"] == 5000 and [s["id"] for s in older["spans"]] == ["a", "b"]
    assert [s["offset_ms"] for s in older["spans"]] == [0, 3000] and older["cost_usd"] == 0.002


def test_calls_made_through_the_api_show_up_with_their_area(fake: FakeClient, tmp_path: Path) -> None:
    client = make_client(fake, tmp_path)
    assert client.post("/api/messages", json=HELLO, headers=LAB).status_code == 200
    seen = client.get("/api/observability", headers=LAB).json()
    assert seen["totals"]["calls"] == 1 and seen["totals"]["input_tokens"] == 1000 and seen["totals"]["timed"] == 1
    call = seen["calls"][0]
    assert call["area"] == "messages" and call["route"] == "POST /messages" and call["trace"]
    assert call["latency_ms"] is not None and call["model"] == "claude-haiku-5-5" and call["status"] == "ok"
    assert seen["by_area"][0]["area"] == "messages" and seen["by_model"][0]["model"] == "claude-haiku-5-5"
    assert seen["traces"][0]["trace"] == call["trace"] and len(seen["traces"][0]["spans"]) == 1
    assert seen["session"]["charges"] == 1 and seen["kept"]["from_earlier_starts"] == 0
    assert client.get("/api/observability").status_code == 403  # the lab header is needed, as everywhere
    assert client.get("/api/observability?scope=nope", headers=LAB).status_code == 400
    cleared = client.delete("/api/observability", headers=LAB).json()
    assert cleared["totals"]["calls"] == 0 and cleared["session"]["charges"] == 1  # the budget still counts it


def test_two_calls_in_one_request_share_a_trace(tmp_path: Path) -> None:
    bad = {**SINE, "functions": [{"expression": "open(x)", "label": "nope"}]}
    fake = ScriptedClient([[text(json.dumps(bad))], [text(json.dumps(SINE))]])
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    from backend.tests.test_whiteboard import png
    assert client.post("/api/whiteboard/read", headers=LAB, json={"image": png(), "prompt": "Plot"}).status_code == 200
    seen = client.get("/api/observability", headers=LAB).json()
    assert len(seen["traces"]) == 1 and len(seen["traces"][0]["spans"]) == 2 and seen["traces"][0]["area"] == "whiteboard"
    assert (tmp_path / "observability" / "calls.jsonl").read_text().count("\n") == 2


def test_a_gpt_call_is_timed_like_a_claude_call(tmp_path: Path) -> None:
    from types import SimpleNamespace

    from backend.app.gateways.azure_openai import AzureOpenAI

    reply = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="{}", refusal=None), finish_reason="stop")],
        usage=SimpleNamespace(prompt_tokens=120, completion_tokens=30, prompt_tokens_details=None))
    calls = CallLog(tmp_path / "calls.jsonl")
    gpt = AzureOpenAI("https://example", ["gpt-5.4-mini"], calls=calls)
    gpt._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **_: reply)))
    _, usage = gpt.structured("gpt-5.4-mini", "system", {"type": "object"}, "hello", 100)
    SpendTracker(1.0, calls).charge(SimpleNamespace(usage=usage), "gpt-5.4-mini")
    [call] = calls.calls()
    assert call["kind"] == "gpt" and call["latency_ms"] is not None and call["input_tokens"] == 120


def test_a_failed_gpt_call_is_logged_and_shown_as_an_api_error(tmp_path: Path) -> None:
    from types import SimpleNamespace

    import httpx
    import openai

    from backend.app.core.errors import ApiError
    from backend.app.gateways.azure_openai import AzureOpenAI

    def busy(**_: Any) -> Any:
        request = httpx.Request("POST", "https://example")
        raise openai.RateLimitError("busy", response=httpx.Response(429, request=request), body=None)

    calls = CallLog(tmp_path / "calls.jsonl")
    gpt = AzureOpenAI("https://example", ["gpt-5.4-mini"], calls=calls)
    gpt._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=busy)))
    with pytest.raises(ApiError) as caught:
        gpt.chat("gpt-5.4-mini", [{"role": "user", "content": "hi"}])
    assert caught.value.status == 429
    [call] = calls.calls()
    assert call["status"] == "error" and call["error"] == "RateLimitError" and call["model"] == "gpt-5.4-mini"
