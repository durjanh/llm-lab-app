"""Claude at work: the deterministic parts (templates, redaction, validation, the rules code adds) and one scripted
call per live tool. No network."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.api import __dict__ as api_namespace
from backend.app.core.errors import ApiError
from backend.app.gateways.claude import ClaudeGateway
from backend.app.main import create_app
from backend.app.services.at_work import (TASK_TYPES, AtWorkService, build_prompt, check_problems, decompose_problems,
                                          finish_check, finish_use_case, redact, rewrite_problems, use_case_problems)
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB


def service(script: list[list[dict]]) -> tuple[AtWorkService, ScriptedClient, SpendTracker]:
    fake, spend = ScriptedClient(script), SpendTracker(1.0)
    return AtWorkService(ClaudeGateway(fake), spend), fake, spend


def reply(obj: dict) -> list[dict]:
    return [text(json.dumps(obj))]


# ---- templates

@pytest.mark.parametrize("kind", list(TASK_TYPES))
def test_every_task_type_builds_all_five_sections(kind: str) -> None:
    built = build_prompt(kind, "plan the Q3 newsletter", "Audience: staff")
    assert list(built["sections"]) == ["role", "context", "task", "constraints", "output_format"]
    assert "plan the Q3 newsletter" in built["sections"]["task"] and "Audience: staff" in built["sections"]["context"]
    assert built["prompt"].count("<role>") == 1 and "</output_format>" in built["prompt"]


def test_task_types_differ_and_bad_input_is_refused() -> None:
    a, b = build_prompt("analysis", "x goal"), build_prompt("brainstorming", "x goal")
    assert a["sections"]["constraints"] != b["sections"]["constraints"]
    assert "Ask me" in a["sections"]["context"]
    with pytest.raises(ValueError):
        build_prompt("poetry", "goal")
    with pytest.raises(ValueError):
        build_prompt("drafting", "   ")


# ---- redaction

def test_redact_replaces_what_code_can_recognise() -> None:
    out, kinds = redact("Email jo.bloggs@example.org or call 020 7946 0958, NI AB 12 34 56 C, SW1A 1AA, card 4111 1111 1111 1111")
    assert "@" not in out and "7946" not in out and "SW1A" not in out and "4111" not in out and "AB 12" not in out
    assert {"email address", "phone number", "postcode", "card number", "National Insurance number"} <= set(kinds)


def test_redact_leaves_ordinary_numbers_alone() -> None:
    out, kinds = redact("We shipped 1200 orders in 2025, up 14 per cent.")
    assert out == "We shipped 1200 orders in 2025, up 14 per cent." and kinds == []


# ---- validators and the rules code adds

def test_decompose_and_rewrite_validation() -> None:
    step = {"title": "t", "what_to_ask": "a", "check_before_next": "c", "depends_on_previous": False}
    assert decompose_problems({"summary": "s", "steps": [step, step]}) == []
    assert decompose_problems({"summary": "s", "steps": [step]})
    ok = {"versions": [{"audience": "Board", "text": "t", "what_changed": "w", "why": "y"},
                       {"audience": "Customer", "text": "t", "what_changed": "w", "why": "y"}]}
    assert rewrite_problems(ok, ["board", "Customer"]) == []
    assert rewrite_problems(ok, ["Board", "Press"]) and rewrite_problems(ok, ["Board"])


def claim(verdict: str) -> dict:
    return {"claim": "c", "verdict": verdict, "evidence": "e"}


def test_without_a_source_no_claim_can_be_supported() -> None:
    out = {"claims": [claim("supported")], "verdict": "send", "verdict_reason": "r"}
    assert check_problems(out, has_source=True) == []
    assert "no source" in " ".join(check_problems(out, has_source=False))
    assert check_problems({**out, "verdict": "maybe"}, True) and check_problems({**out, "claims": []}, True)


def test_the_review_level_is_raised_never_lowered() -> None:
    base = {"claims": [claim("supported")], "details_to_check": [], "bias_signs": [], "verdict": "send",
            "verdict_reason": "Looks fine."}
    assert finish_check(json.loads(json.dumps(base)))["verdict"] == "send"
    bad = finish_check({**base, "claims": [claim("contradicted")]})
    assert bad["verdict"] == "review_first" and bad["raised_by_code"] and "contradicts" in bad["verdict_reason"]
    detail = finish_check({**base, "details_to_check": [{"detail": "s. 14.3", "kind": "section_number", "why": "w"}]})
    assert detail["verdict"] == "review_first"
    biased = finish_check({**base, "bias_signs": [{"quote": "q", "concern": "c"}]})
    assert biased["verdict"] == "review_first"
    strict = finish_check({**base, "claims": [claim("contradicted")], "verdict": "do_not_send"})
    assert strict["verdict"] == "do_not_send" and not strict["raised_by_code"]


def test_personal_data_stops_a_task_being_plain_appropriate() -> None:
    out = {"verdict": "appropriate", "reasons": [], "redacted_description": "Email [CLIENT] at bob@example.com"}
    done = finish_use_case(out, "Summarise notes about Bob, bob@example.com")
    assert done["verdict"] == "needs_care" and done["raised_by_code"] and "@" not in done["redacted_description"]
    assert done["personal_data_found_by_code"] == ["email address"]
    clean = finish_use_case({"verdict": "appropriate", "reasons": [], "redacted_description": "Draft a memo"}, "Draft a memo")
    assert clean["verdict"] == "appropriate" and not clean["raised_by_code"]
    assert use_case_problems({"verdict": "needs_care", "redacted_description": "x",
                              "escalate": {"needed": True, "to": "none", "reason": "r"}})


# ---- one scripted call per live tool

def test_run_task_runs_the_goal_under_two_task_types_and_charges_both() -> None:
    svc, fake, spend = service([[text("Findings...")], [text("Ideas...")]])
    out = svc.run_task("cut churn", "", ["analysis", "brainstorming"], "claude-haiku-5-5")
    assert [r["task_type"] for r in out["runs"]] == ["analysis", "brainstorming"] and out["runs"][1]["answer"] == "Ideas..."
    assert "<constraints>" in fake.calls[0][1]["messages"][0]["content"] and out["cost_usd"] > 0 and spend.calls == 2


def test_decompose_retries_once_then_returns_steps() -> None:
    step = {"title": "Gather", "what_to_ask": "List sources", "check_before_next": "Sources are real",
            "depends_on_previous": False}
    svc, fake, _ = service([reply({"summary": "s", "steps": [step]}), reply({"summary": "s", "steps": [step, step]})])
    out = svc.decompose("Plan and write our annual report with charts and a launch email", None)
    assert len(out["steps"]) == 2 and out["tries"][0]["problems"] and "did not pass" in fake.calls[1][1]["messages"][-1]["content"]


def test_rewrite_returns_one_version_per_audience() -> None:
    versions = [{"audience": a, "text": f"For {a}", "what_changed": "shorter", "why": "busy"} for a in ("Executive", "Customer")]
    svc, fake, _ = service([reply({"versions": versions})])
    out = svc.rewrite("Our outage lasted 40 minutes and affected 2% of users.", ["Executive", "Customer"], None)
    assert [v["audience"] for v in out["versions"]] == ["Executive", "Customer"]
    assert "output_config" in fake.calls[0][1]


def test_check_finds_a_fabricated_section_and_escalates() -> None:
    found = {"claims": [claim("unverifiable")], "details_to_check": [{"detail": "Section 4.2.1", "kind": "section_number",
             "why": "Not in the source"}], "bias_signs": [], "verdict": "send", "verdict_reason": "Fine."}
    svc, fake, _ = service([reply(found)])
    out = svc.check("Under Section 4.2.1 refunds are due in 14 days.", "Refunds are due within 14 days.", None)
    assert out["verdict"] == "review_first" and out["raised_by_code"] and out["has_source"]
    assert "confidence" in fake.calls[0][1]["system"]


def test_use_case_redacts_and_flags() -> None:
    result = {"verdict": "needs_care", "reasons": ["Contains staff data"], "data_issues": [{"item": "names", "kind": "personal",
              "action": "Anonymise"}], "redacted_description": "Summarise reviews for [EMPLOYEE] jo@example.com",
              "escalate": {"needed": False, "to": "none", "reason": ""}, "safer_approach": "Anonymise first."}
    svc, _, _ = service([reply(result)])
    out = svc.use_case("Summarise performance reviews for Jo Smith", "Reviews, jo@example.com", None)
    assert "@" not in out["redacted_description"] and out["verdict"] == "needs_care"


def test_a_second_invalid_answer_is_refused() -> None:
    svc, _, _ = service([[text("not json")], [text("still not")]])
    with pytest.raises(ApiError) as err:
        svc.decompose("Plan and write our annual report with charts and a launch email", None)
    assert err.value.status == 502


# ---- routes (run once the router is wired)

def _wired() -> bool:
    return "at_work" in api_namespace


@pytest.mark.skipif(not _wired(), reason="route not wired yet")
def test_routes(tmp_path: Path) -> None:
    versions = [{"audience": a, "text": "t", "what_changed": "w", "why": "y"} for a in ("A one", "B two")]
    fake = ScriptedClient([reply({"versions": versions})])
    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    t = client.get("/api/at-work/template", headers=LAB, params={"task_type": "research", "goal": "market"})
    assert t.status_code == 200 and "market" in t.json()["prompt"]
    assert client.get("/api/at-work/template", headers=LAB, params={"task_type": "x"}).status_code == 400
    body = {"source": "Our outage lasted 40 minutes.", "audiences": ["A one", "B two"]}
    r = client.post("/api/at-work/rewrite", headers=LAB, json=body)
    assert r.status_code == 200 and len(r.json()["versions"]) == 2
    assert client.post("/api/at-work/rewrite", json=body).status_code in (400, 403)
    assert client.post("/api/at-work/rewrite", headers=LAB, json={**body, "audiences": ["A one"]}).status_code == 400
