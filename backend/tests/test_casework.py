"""The case-handling lab, with fake Azure OpenAI and Azure AI Search: no network, no cost."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace as NS
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services.casework import (DRAFTER, EVIDENCE, INTAKE, PLANNER, REVISE, VERIFIER, AuditLog, policy_chunks,
                                           rule_check)
from backend.app.services.casework_data import CASES, EXPECTED
from backend.app.settings import Settings
from backend.tests.test_api import LAB

USAGE = NS(input_tokens=500, cache_read_input_tokens=0, cache_creation_input_tokens=0, output_tokens=100)


def draft(decision: str, total: int) -> dict:
    return {"decision": decision, "reasons": "r", "goodwill": "",
            "compensation": {"target_date": "2026-08-11", "days_late": 35, "daily_rate_gbp": 5, "delay_gbp": 175,
                             "service_failure_gbp": 50, "vulnerability_gbp": 100, "total_gbp": total, "working": "w"},
            "letter": "Dear Mrs Okafor, your complaint is upheld.", "claims": [{"claim": "Reported 4 August", "sources": ["F1"]}]}


class FakeGPT:
    """Answers each agent by its system prompt. The first draft gets the total wrong, so the checks
    send it back for one revision."""
    models = ["gpt-5.4-mini"]
    embedding_deployment = "text-embedding-3-small"

    def __init__(self) -> None:
        self.calls: list[str] = []

    def chat(self, model: str, messages: list[dict], *, tools=None, schema=None, max_tokens=4000) -> tuple[Any, Any]:
        system = messages[0]["content"]
        agent = {INTAKE: "intake", EVIDENCE: "evidence", PLANNER: "planner", DRAFTER: "drafter", VERIFIER: "verifier", REVISE: "revise"}[system]
        self.calls.append(agent)
        if agent == "evidence" and not any(m["role"] == "tool" for m in messages):
            calls = [NS(id=f"t{i}", function=NS(name=n, arguments=json.dumps(a))) for i, (n, a) in
                     enumerate([("get_tenancy", {"tenant_id": "T-1042"}), ("get_repairs", {"property_id": "P-881"}),
                                ("get_contact_history", {"case_id": "C-301"})])]
            return NS(content=None, tool_calls=calls), USAGE
        answer = {
            "intake": {"summary": "s", "category": "repairs", "issues": ["mould"], "resident_wants": ["compensation"], "vulnerability_mentioned": "children"},
            "evidence": {"facts": [{"fact": "Damp and mould reported 2026-08-04", "source": "repairs"}]},
            "planner": {"queries": ["damp timescale", "delay payment"]},
            "drafter": draft("upheld", 275),
            "revise": draft("upheld", 325),
            "verifier": {"results": [{"claim": "Reported 4 August", "supported": True, "note": ""}]},
        }[agent]
        return NS(content=json.dumps(answer), tool_calls=None), USAGE

    def embed(self, texts: list[str]) -> tuple[list[list[float]], Any]:
        return [[0.1] * 4 for _ in texts], USAGE


class FakeSearch:
    endpoint = "https://search.example"

    def __init__(self) -> None:
        self.indexes: dict[str, list[dict]] = {}
        self.queries: list[str] = []

    def index_exists(self, name: str) -> bool:
        return name in self.indexes

    def create_index(self, definition: dict) -> None:
        self.indexes[definition["name"]] = []

    def upload(self, index: str, docs: list[dict]) -> None:
        self.indexes[index] += docs

    def count(self, index: str) -> int:
        return len(self.indexes[index])

    def hybrid(self, index, text, vector, top, select, semantic_config=None):
        self.queries.append(text)
        return [{**{k: d[k] for k in select}, "@search.score": 0.03, "@search.rerankerScore": 2.5} for d in self.indexes[index][:top]]


@pytest.fixture
def lab(tmp_path: Path):
    gpt, search = FakeGPT(), FakeSearch()
    fake = NS(messages=None, beta=NS(messages=None), models=NS(retrieve=lambda m: {"id": m}))
    settings = Settings(port=8000, frontend_dist=tmp_path, models_dir=tmp_path / "none", sites_dir=tmp_path / "sites",
                        casework_dir=tmp_path / "casework")
    with TestClient(create_app(settings, client=fake, browser=NS(available=False), gpt=gpt, search=search),
                    base_url="http://localhost:8000") as client:
        yield client, gpt, search


def events(response) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def test_the_rule_check_matches_every_hand_worked_outcome() -> None:
    for case in CASES:
        r = rule_check(case)
        assert (r["decision"], r["total_gbp"]) == (EXPECTED[case["case_id"]]["decision"], EXPECTED[case["case_id"]]["compensation_gbp"])


def test_policies_are_chunked_by_section() -> None:
    chunks = policy_chunks()
    assert len({c["id"] for c in chunks}) == len(chunks) == 12
    assert any(c["section"] == "Service failure payment" and "£50" in c["content"] for c in chunks)


def test_a_case_runs_through_the_agents_is_revised_and_waits_for_a_person(lab: Any) -> None:
    client, gpt, search = lab
    out = events(client.post("/api/casework/cases/C-301/run", headers=LAB))
    steps = [(e["step"], e.get("round")) for e in out if e["type"] == "step"]
    assert steps == [("intake", None), ("evidence", None), ("policy", None), ("draft", 1), ("checks", 1), ("draft", 2), ("checks", 2)]
    evidence = next(e["data"] for e in out if e.get("step") == "evidence")
    assert [c["tool"] for c in evidence["calls"]] == ["get_tenancy", "get_repairs", "get_contact_history"]
    first, final = [e["data"] for e in out if e.get("step") == "checks"]
    assert first["mismatches"] == ["total_gbp"] and final["mismatches"] == []  # the rule check caught £275 vs £325
    assert search.queries == ["damp timescale", "delay payment"] and len(search.indexes["casework-policies"]) == 12
    done = out[-1]
    assert done["type"] == "done" and done["status"] == "awaiting approval" and done["cost"] > 0

    # Nothing is sent until a named caseworker approves; then it cannot be decided twice.
    run_id = done["run_id"]
    assert client.get("/api/casework/info", headers=LAB).json()["cases"][0]["status"] == "awaiting approval"
    r = client.post(f"/api/casework/runs/{run_id}/decision", headers=LAB,
                    json={"action": "approve", "reviewer": "Sam Patel", "letter": "Dear Mrs Okafor, edited.", "note": ""})
    assert r.json() == {"status": "sent", "edited": True}
    again = client.post(f"/api/casework/runs/{run_id}/decision", headers=LAB, json={"action": "reject", "reviewer": "Sam Patel"})
    assert again.status_code == 409

    trail = client.get("/api/casework/audit", params={"case_id": "C-301"}, headers=LAB).json()
    actors = [e["actor"] for e in trail["entries"]]
    assert actors[0] == "system" and "tool:get_repairs" in actors and actors[-1] == "human:Sam Patel"
    assert trail["chain"] == {"intact": True, "broken_at": None}
    assert all(len(e.get("prompt_version", "abcdefgh")) == 8 for e in trail["entries"])


def test_editing_the_audit_log_breaks_the_chain(tmp_path: Path) -> None:
    log = AuditLog(tmp_path / "audit.jsonl")
    for i in range(3):
        log.append({"case_id": "C-1", "actor": "agent", "action": f"step {i}"})
    assert log.verify()["intact"]
    lines = (tmp_path / "audit.jsonl").read_text().splitlines()
    tampered = json.loads(lines[1]) | {"action": "something else"}
    (tmp_path / "audit.jsonl").write_text("\n".join([lines[0], json.dumps(tampered), lines[2]]) + "\n")
    assert log.verify() == {"intact": False, "broken_at": 2}


def test_approving_a_draft_with_problems_needs_a_reason(lab: Any) -> None:
    client, gpt, _ = lab
    run = client.app.state.container.casework
    gen = run.run("C-303")  # the fake drafts "upheld, £275/£325" for a complaint the rules do not uphold
    last = list(gen)[-1]
    r = client.post(f"/api/casework/runs/{last['run_id']}/decision", headers=LAB,
                    json={"action": "approve", "reviewer": "Sam Patel", "letter": "x"})
    assert r.status_code == 400 and "reason" in r.json()["error"]["message"]
    ok = client.post(f"/api/casework/runs/{last['run_id']}/decision", headers=LAB,
                     json={"action": "approve", "reviewer": "Sam Patel", "letter": "x", "note": "Checked with the team lead"})
    assert ok.json()["status"] == "sent"


def test_the_evaluation_reports_first_draft_and_final_and_gates_the_release(lab: Any) -> None:
    client, *_ = lab
    out = events(client.post("/api/casework/evaluate", headers=LAB))
    rows = [e["row"] for e in out if e["type"] == "case"]
    assert len(rows) == 5 and all(r["revised"] for r in rows if r["case_id"] == "C-301")
    done = out[-1]
    assert done["type"] == "done" and set(done["metrics"]) == {"first_draft_accuracy", "decision_accuracy", "compensation_accuracy", "groundedness"}
    assert done["passed"] is False  # the fake upholds every case, so the gate must fail
