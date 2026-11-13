"""ReAct and planning patterns: the shop's tools, the answer checks, and each pattern with a scripted client, so no
network and no cost."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.api import deps
from backend.app.gateways.claude import ClaudeGateway
from backend.app.main import create_app
from backend.app.services.planning_patterns import TASKS, TASKS_BY_ID, PlanningPatternsService, Shop, calculate
from backend.app.services.runs import RunRegistry, RunStreamer
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text, use
from backend.tests.test_api import LAB

HAIKU = "claude-haiku-5-5"


def test_the_calculator_does_arithmetic_and_nothing_else() -> None:
    assert calculate("(12*149)*0.9 + 30*34.5*0.9 + 8*64") == pytest.approx(3052.7)
    assert calculate("round(436*1.2, 2)") == 523.2
    assert calculate("£1,035 / 2") == 517.5
    for bad in ("__import__('os')", "2**8", "abs(-1)", "x + 1"):
        with pytest.raises(ValueError):
            calculate(bad)


def test_the_shop_tools_answer_and_the_warehouse_fails_once_when_flaky() -> None:
    shop = Shop(flaky=True)
    assert shop.run("lookup_product", {"product": "Office Chairs"})["current_price"] == 149.0
    assert shop.run("lookup_order", {"order_id": "n-1063"})["lines"][0]["price_paid"] == 289.0
    assert "error" in shop.run("stock_check", {"product_id": "P-300"})
    assert shop.run("stock_check", {"product_id": "P-300"})["in_stock"] == 6
    assert shop.run("dates", {"operation": "add_working_days", "date": "2026-03-16", "days": 8})["date"] == "2026-03-26"
    assert shop.run("search_policies", {"query": "refund returns"})["sections"][0]["title"] == "Returns"
    assert "error" in shop.run("rm_rf", {})
    assert "error" in shop.run("dates", {"operation": "weekday", "date": "next tuesday"})


def test_each_task_marks_the_right_answer_and_rejects_a_wrong_one() -> None:
    right = {"basket": "£401.50", "order-vat": "The total is £523.20.", "stock": "No: Standing Desk is short by 2 units.",
             "delivery": "Thursday 26 March 2026", "refund": "Yes, a refund of £289.00.", "bulk": "Total £3,663.24."}
    wrong = {"basket": "£411.50", "order-vat": "£436.00", "stock": "Yes, all in stock.", "delivery": "25 March",
             "refund": "Yes, £319.00.", "bulk": "£3,743.40"}
    for task in TASKS:
        assert task["check"](right[task["id"]])[0], task["id"]
        assert not task["check"](wrong[task["id"]])[0], task["id"]


def make(tmp_path: Path, script: list[list[dict]]) -> tuple[TestClient, ScriptedClient]:
    settings = Settings(port=8000, budget_usd=5.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    fake = ScriptedClient(script)
    app = create_app(settings, client=fake)
    service = PlanningPatternsService(ClaudeGateway(fake), SpendTracker(5.0), RunStreamer(RunRegistry(), 5.0),
                                      parallel=False)
    app.dependency_overrides[deps.planning_patterns] = lambda: service
    return TestClient(app, base_url="http://localhost:8000"), fake


def run(client: TestClient, task: str, patterns: list[str], **extra: Any) -> list[dict]:
    r = client.post("/api/planning-patterns/run", headers=LAB,
                    json={"task": task, "patterns": patterns, "model": HAIKU, **extra})
    assert r.status_code == 200, r.text
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


def result(events: list[dict], pattern: str) -> dict:
    return next(e for e in events if e["type"] == "result" and e["pattern"] == pattern)


def test_the_tool_loop_runs_tools_and_is_marked(tmp_path: Path) -> None:
    client, fake = make(tmp_path, [
        [use("lookup_product", {"product": "Desk Lamp"}, 1), use("lookup_product", {"product": "Office Chair"}, 2)],
        [use("calculator", {"expression": "3*34.5 + 2*149"})],
        [use("final_answer", {"answer": "£401.50 before VAT"})],
    ])
    events = run(client, "basket", ["tool_loop"])
    r = result(events, "tool_loop")
    assert r["passed"] and r["model_calls"] == 3 and r["tool_calls"] == 3 and r["cost_usd"] > 0
    assert [e["tool"] for e in events if e.get("kind") == "action"] == ["lookup_product", "lookup_product", "calculator"]
    # the tool results went back to the model, paired with their calls
    second = fake.calls[1][1]["messages"]
    assert second[-1]["content"][0]["tool_use_id"] == "toolu_lookup_product_1"
    assert {t["name"] for t in fake.calls[0][1]["tools"]} >= {"calculator", "final_answer", "search_policies"}
    assert events[-1]["type"] == "done" and events[-1]["passed"] == ["tool_loop"]


def test_react_publishes_its_thoughts_and_notes_an_action_without_one(tmp_path: Path) -> None:
    client, fake = make(tmp_path, [
        [text("Thought: I need the order's lines first."), use("lookup_order", {"order_id": "N-1042"})],
        [use("calculator", {"expression": "(2*149 + 4*34.5)*1.2"})],  # no thought this time
        [text("Thought: 436 plus VAT is 523.20."), use("final_answer", {"answer": "£523.20 including VAT"})],
    ])
    events = run(client, "order-vat", ["react"])
    thoughts = [e["text"] for e in events if e.get("kind") == "thought"]
    assert thoughts[0].startswith("Thought: I need") and len(thoughts) == 2
    assert any(e.get("kind") == "note" and "without writing a Thought" in e["text"] for e in events)
    assert result(events, "react")["passed"]
    assert "Thought:" in fake.calls[0][1]["system"]


def test_plan_and_execute_replans_when_a_step_fails(tmp_path: Path) -> None:
    client, fake = make(tmp_path, [
        [text(json.dumps({"steps": ["Look up order N-1057", "Check stock of P-300", "Check stock of P-400",
                                    "Compare with the order"]}))],
        [use("lookup_order", {"order_id": "N-1057"})],
        [use("step_result", {"ok": True, "result": "8 x P-300, 8 x P-400"})],
        [use("stock_check", {"product_id": "P-300"})],  # the warehouse times out the first time
        [use("step_result", {"ok": False, "result": "The warehouse system timed out."})],
        [text(json.dumps({"steps": ["Check stock of P-300 again", "Check stock of P-400", "Compare"]}))],  # replan
        [use("stock_check", {"product_id": "P-300"})],
        [use("step_result", {"ok": True, "result": "6 in stock"})],
        [use("stock_check", {"product_id": "P-400"})],
        [use("step_result", {"ok": True, "result": "40 in stock"})],
        [use("step_result", {"ok": True, "result": "Standing Desk short by 2"})],
        [text(json.dumps({"answer": "No. Standing Desk is short by 2 units."}))],
    ])
    events = run(client, "stock", ["plan_execute"])
    plans = [e for e in events if e.get("kind") == "plan"]
    assert [p["revision"] for p in plans] == [0, 1] and plans[1]["steps"][0] == "Check stock of P-300 again"
    assert [e["ok"] for e in events if e.get("kind") == "step_done"] == [True, False, True, True, True]
    r = result(events, "plan_execute")
    assert r["passed"] and r["model_calls"] == 12
    assert "output_config" in fake.calls[0][1] and "step_result" in {t["name"] for t in fake.calls[1][1]["tools"]}
    assert "Steps so far" in fake.calls[5][1]["messages"][0]["content"]


def test_reflexion_retries_after_the_critic_finds_the_trap(tmp_path: Path) -> None:
    client, fake = make(tmp_path, [
        [text("Thought: get the order."), use("lookup_order", {"order_id": "N-1063"})],
        [text("Thought: and today's price."), use("lookup_product", {"product": "P-300"})],
        [text("Thought: done."), use("final_answer", {"answer": "Yes, a refund of £319.00."})],
        [text(json.dumps({"verdict": "revise", "problems": ["The policy refunds the price paid, £289.00 on the order."]}))],
        [text("Thought: use the price paid."), use("search_policies", {"query": "returns refund"})],
        [text("Thought: within 30 days."), use("final_answer", {"answer": "Yes, a refund of £289.00, the price paid."})],
    ])
    events = run(client, "refund", ["reflexion"])
    assert next(e for e in events if e.get("kind") == "attempt")["text"] == "Yes, a refund of £319.00."
    critique = next(e for e in events if e.get("kind") == "critique")
    assert critique["verdict"] == "revise" and "price paid" in critique["problems"][0]
    assert result(events, "reflexion")["passed"]
    critic_prompt = fake.calls[3][1]["messages"][0]["content"]
    assert "lookup_order" in critic_prompt and "Checks:" in critic_prompt and "£319.00" in critic_prompt
    assert "reviewer found these problems" in fake.calls[4][1]["messages"][0]["content"]


def test_a_pattern_stops_at_the_step_cap(tmp_path: Path) -> None:
    looping = [[use("calculator", {"expression": "1+1"}, i)] for i in range(20)]
    client, fake = make(tmp_path, looping)
    events = run(client, "basket", ["tool_loop"])
    r = result(events, "tool_loop")
    assert not r["passed"] and "step cap" in r["stopped"] and r["model_calls"] == 14 and len(fake.calls) == 14


def test_a_run_stops_at_its_budget() -> None:
    looping = [[use("calculator", {"expression": "1+1"}, i)] for i in range(20)]
    fake = ScriptedClient(looping)
    service = PlanningPatternsService(ClaudeGateway(fake), SpendTracker(5.0), RunStreamer(RunRegistry(), 5.0))
    lines = service.run("basket", ["tool_loop"], HAIKU, budget_usd=0.0005)  # each scripted call costs $0.00015
    events = [json.loads(line) for line in lines if line.strip()]
    r = result(events, "tool_loop")
    assert "budget" in r["stopped"] and len(fake.calls) < 14


def test_bad_requests_are_refused(tmp_path: Path) -> None:
    client, _ = make(tmp_path, [])
    assert client.post("/api/planning-patterns/run", json={"task": "basket", "patterns": ["react"]}).status_code in (400, 403)
    assert client.post("/api/planning-patterns/run", headers=LAB,
                       json={"task": "nope", "patterns": ["react"]}).status_code == 404
    assert client.post("/api/planning-patterns/run", headers=LAB,
                       json={"task": "basket", "patterns": ["magic"]}).status_code == 400
    assert client.post("/api/planning-patterns/run", headers=LAB,
                       json={"task": "basket", "patterns": ["react"], "model": "gpt-2"}).status_code in (400, 422)
    info = client.get("/api/planning-patterns/info", headers=LAB).json()
    assert len(info["tasks"]) == len(TASKS) and "check" not in info["tasks"][0] and TASKS_BY_ID["stock"]["flaky"]
