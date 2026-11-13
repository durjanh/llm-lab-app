"""The delivery design tool: code checks a model's design has every section and a valid pattern, asks once for a fix."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.gateways.claude import ClaudeGateway
from backend.app.main import create_app
from backend.app.services.delivery import DeliveryService, problems
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB

GOOD = {
    "summary": "A claims-triage assistant.",
    "requirements": {"functional": ["Summarise a claim"], "infrastructure": ["UK data residency"],
                     "success_measures": ["90% triage agreement"]},
    "pattern": {"choice": "workflow", "reasons": ["Steps are fixed"], "would_change_if": ["Claims vary widely"]},
    "components": {"model": {"choice": "claude-haiku-5-5", "reasons": ["Fast"]}, "retrieval": "Policy search",
                   "tools": [{"name": "lookup_claim", "purpose": "Read a claim", "mechanism": "direct_api",
                              "why": "One internal API"}], "guardrails": ["Output check"]},
    "value": [{"pillar": "efficiency", "claim": "Faster triage", "measure": "Minutes per claim"}],
    "risks": [{"risk": "Wrong triage", "mitigation": "Sample review", "human_in_the_loop": "Handler signs off"}],
    "compliance": [{"regulation": "GDPR", "why_it_may_apply": "Personal data", "what_to_check": "Lawful basis"}],
    "authn_authz": ["Per-user identity"],
    "evaluation": {"metrics": {"accuracy": "a", "latency": "b", "cost": "c", "safety": "d"}, "dataset": "200 claims",
                   "ab_test": "Shadow mode"},
    "slas": [{"name": "Latency", "target": "p95 under 5 s", "how_measured": "Traces"}],
    "open_questions": ["Who owns the policy library?"],
    "adr": {"title": "Use a workflow", "status": "Proposed", "context": "c", "decision": "d",
            "alternatives": ["Agent"], "consequences": ["Less flexible"]},
}


def service(script: list[list[dict]]) -> tuple[DeliveryService, ScriptedClient]:
    fake = ScriptedClient(script)
    return DeliveryService(ClaudeGateway(fake), SpendTracker(1.0)), fake


def test_a_complete_design_has_no_problems() -> None:
    assert problems(GOOD) == []


def test_missing_sections_and_a_bad_pattern_are_named() -> None:
    bad = copy.deepcopy(GOOD)
    del bad["slas"]
    bad["pattern"]["choice"] = "swarm"
    bad["value"][0]["pillar"] = "vibes"
    bad["components"]["tools"][0]["mechanism"] = "carrier pigeon"
    found = " ".join(problems(bad))
    assert "'slas'" in found and "'swarm'" in found and "vibes" in found and "tools[0].mechanism" in found
    assert problems([]) == ["The reply was not a JSON object."]
    assert len(problems({})) >= 10


def test_design_retries_once_with_the_problems_then_returns_it() -> None:
    bad = copy.deepcopy(GOOD)
    bad["pattern"]["choice"] = "swarm"
    svc, fake = service([[text(json.dumps(bad))], [text(json.dumps(GOOD))]])
    out = svc.design("A bank wants to triage insurance claims faster.", "claude-haiku-5-5")
    assert out["design"]["pattern"]["choice"] == "workflow" and out["cost_usd"] > 0
    assert out["tries"][0]["problems"] and out["tries"][1]["problems"] == []
    assert "'swarm'" in fake.calls[1][1]["messages"][-1]["content"]
    assert fake.calls[0][1]["output_config"]["format"]["type"] == "json_schema"


def test_unparseable_then_good_is_accepted() -> None:
    svc, _ = service([[text("not json")], [text(json.dumps(GOOD))]])
    assert svc.design("A retailer wants a returns assistant.", None)["tries"][0]["problems"]


def test_a_second_bad_design_is_refused() -> None:
    svc, _ = service([[text("{}")], [text("{}")]])
    with pytest.raises(ApiError) as exc:
        svc.design("A council wants to answer planning questions.", None)
    assert exc.value.status == 502 and "second try" in exc.value.message


def _wired() -> bool:
    init = Path(__file__).parents[1] / "app" / "api" / "__init__.py"
    return "delivery" in init.read_text()


@pytest.mark.skipif(not _wired(), reason="route not wired yet")
def test_route_returns_the_design_and_checks_the_guards(tmp_path: Path) -> None:
    fake = ScriptedClient([[text(json.dumps(GOOD))]])
    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    brief = "A bank wants to triage insurance claims faster."
    r = client.post("/api/delivery/design", headers=LAB, json={"brief": brief, "model": "claude-haiku-5-5"})
    assert r.status_code == 200 and r.json()["design"]["pattern"]["choice"] == "workflow"
    assert client.post("/api/delivery/design", json={"brief": brief}).status_code in (400, 403)
    assert client.post("/api/delivery/design", headers=LAB, json={"brief": "short"}).status_code == 400


def test_flat_rows_from_the_model_become_the_pages_rows() -> None:
    """Claude's structured output cannot take the full nested schema, so rows arrive as "a | b | c" strings."""
    from backend.app.services.delivery import unflatten
    flat = {"risks": ["Wrong triage | Sample review | Handler signs off"],
            "compliance": ["GDPR | Personal data | Lawful basis | and retention"],
            "slas": ["Latency | p95 under 5 s"],
            "evaluation": {"accuracy": "a", "latency": "b", "cost": "c", "safety": "d", "dataset": "200", "ab_test": "shadow"}}
    out = unflatten(flat)
    assert out["risks"] == [{"risk": "Wrong triage", "mitigation": "Sample review", "human_in_the_loop": "Handler signs off"}]
    assert out["compliance"][0]["what_to_check"] == "Lawful basis | and retention"
    assert out["slas"][0] == {"name": "Latency", "target": "p95 under 5 s", "how_measured": ""}
    assert out["evaluation"] == {"metrics": {"accuracy": "a", "latency": "b", "cost": "c", "safety": "d"},
                                 "dataset": "200", "ab_test": "shadow"}
