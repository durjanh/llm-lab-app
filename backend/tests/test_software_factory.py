"""The software factory with fake agents and a small invented project: tiers, gates, people, merges, reverts and the
track record. The project's own tests really run (they are this file's, in a temporary folder); no model is called."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services import factory_policy as P
from backend.app.services import software_factory as F
from backend.app.settings import Settings
from backend.tests.test_assistant import Fake

LAB = {"X-LLM-Lab": "1", "Origin": "http://localhost:8000"}
HAIKU = "claude-haiku-5-5"

CALC = 'def add(a, b):\n    """a + b."""\n    return a + b\n\n\ndef sub(a, b):\n    """a - b."""\n    return a + b\n'
TESTS = ("import unittest\n\nfrom ledger.calc import add, sub\n\n\nclass CalcTests(unittest.TestCase):\n"
         "    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\n"
         "    def test_sub(self):\n        self.assertEqual(sub(5, 3), 2)\n")


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A tiny stand-in for the practice project: one passing test and one failing one (sub adds)."""
    root = tmp_path / "template"
    (root / "ledger").mkdir(parents=True)
    (root / "tests").mkdir()
    (root / "ledger" / "__init__.py").write_text("")
    (root / "ledger" / "calc.py").write_text(CALC)
    (root / "tests" / "__init__.py").write_text("")
    (root / "tests" / "test_calc.py").write_text(TESTS)
    (root / "CLAUDE.example.md").write_text("# Calc\n")
    monkeypatch.setattr(F.C, "PROJECT", root)
    return root


class Box:
    """The sandbox: runs the project's own tests for real, in the change's folder."""
    kind = "sessions"

    def run(self, command: str, root: Path, timeout: int) -> tuple[int, str]:
        # As the real sandbox does: no .pyc files, so an edit of the same size in the same second is never missed.
        p = subprocess.run([sys.executable, "-m", "unittest", "-q"], cwd=root, capture_output=True, text=True,
                           timeout=timeout, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        return p.returncode, p.stdout + p.stderr


class FakeAgent:
    def __init__(self, role: str, root: Path, script: dict[str, Any], log: list):
        self.role, self.root, self.script, self.log = role, root, script, log
        self.spent, self.budget = 0.0, 1.0
        self.cancelled = threading.Event()
        self.stop_hooks: list[Callable] = []
        self.own_test_gate = False
        self.ws = SimpleNamespace(root=root)
        self.n = 0

    def ask(self, prompt: str) -> str:
        self.n += 1
        self.log.append((self.role, prompt))
        self.spent += self.script.get("cost", 0.001)
        if self.spent >= self.budget:
            raise F.C.StopRun(f"the estimated spend ${self.spent:.3f} reached the ${self.budget:.2f} budget")
        step = self.script[self.role]
        return step(self.root, prompt, self.n) if callable(step) else step


def plan(files: str) -> str:
    return f"Approach: small.\n1. Do it.\nFILES: {files}"


def fix_sub(root: Path, prompt: str, n: int) -> str:
    (root / "ledger" / "calc.py").write_text(CALC.replace('"""a - b."""\n    return a + b', '"""a - b."""\n    return a - b'))
    return "Fixed sub."


def add_readme(root: Path, prompt: str, n: int) -> str:
    (root / "README.md").write_text("# Calc\n\nRun the tests with `python -m unittest`.\n")
    return "Added a README."


PASS = '```json\n{"verdict": "pass", "findings": []}\n```'


def lab(tmp_path: Path, script: dict[str, Any], **extra: Any) -> tuple[TestClient, Any, list]:
    extra.setdefault("software_factory_decision_timeout_s", 20)  # a wrong turn fails the test instead of hanging it
    settings = Settings(port=8000, budget_usd=5.0, frontend_dist=tmp_path, models_dir=tmp_path / "none",
                        sites_dir=tmp_path / "sites", casework_dir=tmp_path / "casework",
                        generated_dir=tmp_path / "generated", **extra)
    app = create_app(settings, client=Fake([]))
    svc = app.state.container.software_factory
    log: list = []
    svc.sandbox = Box()
    svc.make_agent = lambda role, model, root, mode, effort, emit: FakeAgent(role, root, script, log)
    return TestClient(app, base_url="http://localhost:8000"), svc, log


def run(client: TestClient, ticket: str, answer: Callable[[TestClient, Any, dict], None] | None = None,
        svc: Any = None) -> list[dict]:
    """Starts a change; when it waits for a person, `answer` is called with the waiting decision."""
    out: dict[str, Any] = {}

    def go() -> None:
        r = client.post("/api/software-factory/changes", headers=LAB, json={"ticket_id": ticket, "model": HAIKU})
        out["status"], out["text"] = r.status_code, r.text

    t = threading.Thread(target=go)
    t.start()
    answered: set[str] = set()
    while t.is_alive():
        if answer and svc is not None:
            for did, w in list(svc._decisions.items()):
                if did not in answered:
                    answered.add(did)
                    answer(client, svc, {"id": did, **w})
        time.sleep(0.05)
    t.join()
    assert out["status"] == 200, out["text"]
    return [json.loads(line) for line in out["text"].splitlines() if line.strip()]


def decide(decision: str, note: str = "", plan_text: str | None = None) -> Callable:
    def answer(client: TestClient, svc: Any, w: dict) -> None:
        r = client.post("/api/software-factory/decide", headers=LAB,
                        json={"run_id": w["run_id"], "decision_id": w["id"], "decision": decision, "note": note,
                              **({"plan": plan_text} if plan_text else {})})
        assert r.status_code == 204, r.text
    return answer


def final(events: list[dict]) -> dict:
    return next(e for e in reversed(events) if e["type"] == "done")["change"]


def commits(svc: Any) -> list[str]:
    _, out = F.git(["log", "--format=%s"], svc.project)
    return out.splitlines()


# ----- the rules -----

def test_declared_tier_is_the_higher_of_kind_and_area() -> None:
    assert P.declared_tier("docs", "docs")[0] == "low"
    assert P.declared_tier("bugfix", "payments")[0] == "high"
    assert P.declared_tier("refactor", "parsing")[0] == "medium"


def test_evidence_only_raises_the_tier() -> None:
    assert P.raise_for_evidence("low", P.Evidence(files=["ledger/payments.py"]))[0] == "high"
    assert P.raise_for_evidence("high", P.Evidence(files=["README.md"]))[0] == "high"  # never lowered
    assert P.raise_for_evidence("low", P.Evidence(diff_lines=P.MEDIUM_DIFF_LINES + 1))[0] == "medium"
    assert P.raise_for_evidence("low", P.Evidence(added="import requests\n"))[0] == "medium"
    assert P.raise_for_evidence("low", P.Evidence(added="from decimal import Decimal\n"))[0] == "low"
    assert P.raise_for_evidence("low", P.Evidence(files=["tests/test_calc.py"]))[0] == "medium"
    assert P.raise_for_evidence("low", P.Evidence(added="x = eval(text)"))[0] == "high"
    assert P.raise_for_evidence("low", P.Evidence(covered={"ledger/new.py": False}))[0] == "medium"


def test_autonomy_adjusts_within_bounds_and_high_never_runs_dark() -> None:
    assert P.effective_tier("low", 0, declared="low")[0] == "medium"
    assert P.effective_tier("medium", 2, declared="medium")[0] == "low"
    assert P.effective_tier("high", 2, declared="high")[0] == "high"
    assert P.effective_tier("medium", 1, declared="medium")[0] == "medium"


def test_review_2_autonomy_never_lowers_a_tier_raised_by_evidence() -> None:
    # Declared low, raised to medium by the work: trust does not take it back down.
    assert P.effective_tier("medium", 2, declared="low", evidence="medium")[0] == "medium"
    # Declared medium, but the work itself also called for medium (a big diff, edited tests): still medium.
    assert P.effective_tier("medium", 2, declared="medium", evidence="medium")[0] == "medium"
    # Declared medium and nothing in the work called for it: a trusted area may run it dark.
    assert P.effective_tier("medium", 2, declared="medium", evidence="low")[0] == "low"


def test_clean_changes_earn_a_level_and_an_escape_costs_one() -> None:
    area = P.new_area()
    for i in range(P.PROMOTE_AFTER - 1):
        assert P.record_merge(area, dark=True, clean=True, when="t", change_id=str(i)) is None
    assert P.record_merge(area, dark=True, clean=True, when="t", change_id="x") is not None
    assert area["level"] == 2
    P.record_merge(area, dark=False, clean=False, when="t", change_id="y")
    assert area["clean_streak"] == 0
    P.record_escape(area, when="t", change_id="z", reverted=True)
    assert area["level"] == 1 and area["escapes"] == 1 and area["reverts"] == 1


def test_parse_helpers() -> None:
    assert F.parse_files("x\nFILES: a.py, `b/c.py`") == ["a.py", "b/c.py"]
    assert F.parse_review("```json\n{\"verdict\": \"changes\", \"findings\": [{\"severity\": \"high\"}]}\n```")[
        "verdict"] == "changes"
    assert F.parse_review("no json here") is None
    assert F.failures("FAIL: test_sub (tests.test_calc.CalcTests.test_sub)\n") == {"tests.test_calc.CalcTests.test_sub"}


# ----- a whole change -----

def test_a_low_risk_change_runs_dark_and_merges(tmp_path: Path, project: Path) -> None:
    client, svc, log = lab(tmp_path, {"planner": plan("README.md"), "implementer": add_readme, "reviewer": PASS})
    ev = run(client, "T1")
    c = final(ev)
    assert c["status"] == "merged" and c["dark"] is True and c["human_steps"] == 0
    assert c["commit"] and commits(svc)[0].startswith("Add a README")
    # The old failure on main does not block it: only new failures do.
    tests = svc.change(c["id"])["tests"]
    assert tests["passed"] and tests["still_failing"] == ["tests.test_calc.CalcTests.test_sub"]
    led = client.get("/api/software-factory/state", headers=LAB).json()["ledger"]["docs"]
    assert led["merged"] == 1 and led["dark"] == 1 and led["clean_streak"] == 1
    whats = [a["what"] for a in svc.change(c["id"])["audit"]]
    assert any(w.startswith("declared tier") for w in whats) and "proposed a plan" in whats
    assert any(w.startswith("tests: no new failures") for w in whats) and any(w.startswith("merged") for w in whats)
    # The reviewer had its own context: its prompt carries the diff, and it is a separate agent from the builder.
    assert [r for r, _ in log] == ["planner", "implementer", "reviewer"]
    assert "README.md" in log[-1][1]
    # Every step was streamed and kept.
    assert (svc.folder / "changes" / c["id"] / "events.jsonl").read_text().count("\n") >= len(ev) - 1


def test_a_plan_touching_a_sensitive_path_raises_the_tier_and_waits_for_a_person(tmp_path: Path, project: Path) -> None:
    client, svc, log = lab(tmp_path, {"planner": plan("ledger/payments.py"), "implementer": fix_sub,
                                      "reviewer": PASS})
    ev = run(client, "T2", decide("reject", "Payments are out of scope for this ticket."), svc)
    c = final(ev)
    assert c["status"] == "rejected" and c["effective_tier"] == "high"
    assert any(e["type"] == "decision_needed" and e["kind"] == "plan" for e in ev)
    assert [r for r, _ in log] == ["planner"]  # nothing was built
    assert client.get("/api/software-factory/state", headers=LAB).json()["ledger"]["parsing"]["overrides"] == 1


def test_a_medium_change_merges_only_after_a_person_approves_the_diff(tmp_path: Path, project: Path) -> None:
    client, svc, _ = lab(tmp_path, {"planner": plan("ledger/calc.py"), "implementer": fix_sub, "reviewer": PASS})
    ev = run(client, "T6", decide("approve"), svc)
    c = final(ev)
    assert c["status"] == "merged" and c["dark"] is False and c["human_steps"] == 1
    kinds = [e["kind"] for e in ev if e["type"] == "decision_needed"]
    assert kinds == ["diff"]
    assert svc.change(c["id"])["tests"]["fixed"] == ["tests.test_calc.CalcTests.test_sub"]


def test_a_person_asking_for_changes_sends_the_note_back_and_the_merge_is_not_clean(tmp_path: Path,
                                                                                    project: Path) -> None:
    answers = iter([("changes", "Add a docstring example."), ("approve", "")])
    client, svc, log = lab(tmp_path, {"planner": plan("ledger/calc.py"), "implementer": fix_sub, "reviewer": PASS})

    def answer(client: TestClient, svc: Any, w: dict) -> None:
        d, note = next(answers)
        decide(d, note)(client, svc, w)

    c = final(run(client, "T6", answer, svc))
    assert c["status"] == "merged"
    assert any("Add a docstring example." in p for r, p in log if r == "implementer")
    led = client.get("/api/software-factory/state", headers=LAB).json()["ledger"]["parsing"]
    assert led["overrides"] == 1 and led["clean_streak"] == 0


def test_a_high_change_uses_the_plan_a_person_edited(tmp_path: Path, project: Path) -> None:
    answers = iter([("approve", "Edited: only neutralise, never reject rows."), ("approve", None)])
    client, svc, log = lab(tmp_path, {"planner": plan("ledger/calc.py"), "implementer": fix_sub, "reviewer": PASS})

    def answer(client: TestClient, svc: Any, w: dict) -> None:
        d, edited = next(answers)
        decide(d, plan_text=edited)(client, svc, w)

    c = final(run(client, "T10", answer, svc))
    assert c["status"] == "merged" and c["human_steps"] == 2 and c["dark"] is False
    build = next(p for r, p in log if r == "implementer")
    assert "only neutralise, never reject rows" in build


def test_no_answer_in_time_expires_the_change(tmp_path: Path, project: Path) -> None:
    client, svc, _ = lab(tmp_path, {"planner": plan("ledger/calc.py"), "implementer": fix_sub, "reviewer": PASS},
                         software_factory_decision_timeout_s=1)
    c = final(run(client, "T6"))
    assert c["status"] == "expired"
    assert len(commits(svc)) == 1  # nothing merged


def test_a_person_can_take_over(tmp_path: Path, project: Path) -> None:
    client, svc, _ = lab(tmp_path, {"planner": plan("ledger/calc.py"), "implementer": fix_sub, "reviewer": PASS})
    c = final(run(client, "T10", decide("take_over"), svc))
    assert c["status"] == "taken_over" and len(commits(svc)) == 1


# ----- the gates -----

@pytest.mark.parametrize("damage, gate", [
    (lambda r: (r / "tests" / "test_calc.py").write_text(TESTS.split("    def test_sub")[0]), "no tests deleted"),
    (lambda r: (r / "tests" / "test_calc.py").write_text(
        TESTS.replace("    def test_sub", "    @unittest.skip('later')\n    def test_sub")), "no tests deleted"),
    (lambda r: (r / "ledger" / "calc.py").write_text(CALC.replace("return a + b\n\n\ndef sub", "return a * b\n\n\ndef sub")),
     "tests: no new failures"),
    (lambda r: (r / "ledger" / "keys.py").write_text('API_KEY = "sk-abcdefghijklmnopqrstuvwxyz123456"\n'),
     "no secrets"),
])
def test_each_gate_blocks_a_bad_change(tmp_path: Path, project: Path, damage: Callable, gate: str) -> None:
    def implement(root: Path, prompt: str, n: int) -> str:
        damage(root)
        return "Done."

    client, svc, _ = lab(tmp_path, {"planner": plan("README.md"), "implementer": implement, "reviewer": PASS})
    c = final(run(client, "T1", decide("approve"), svc))
    assert c["status"] == "blocked"
    gates = svc.change(c["id"])["gates"]
    assert any(g["name"].startswith(gate) and not g["passed"] for g in gates), gates
    assert len(commits(svc)) == 1


def test_a_reviewer_asking_for_changes_gets_one_automatic_fix_round(tmp_path: Path, project: Path) -> None:
    reviews = iter(['```json\n{"verdict": "changes", "findings": [{"severity": "medium", "file": "README.md", '
                    '"issue": "Say how to install it."}]}\n```', PASS])
    client, svc, log = lab(tmp_path, {"planner": plan("README.md"), "implementer": add_readme,
                                      "reviewer": lambda root, prompt, n: next(reviews)})
    c = final(run(client, "T1"))
    assert c["status"] == "merged" and c["dark"] is True
    assert any("Say how to install it." in p for r, p in log if r == "implementer")


def test_a_reviewer_without_a_verdict_fails_closed(tmp_path: Path, project: Path) -> None:
    client, svc, _ = lab(tmp_path, {"planner": plan("README.md"), "implementer": add_readme, "reviewer": "Looks fine."})
    c = final(run(client, "T1"))
    assert c["status"] == "blocked"


def test_the_budget_stop_leaves_a_consistent_state(tmp_path: Path, project: Path) -> None:
    client, svc, _ = lab(tmp_path, {"planner": plan("README.md"), "implementer": add_readme, "reviewer": PASS,
                                    "cost": 0.3}, software_factory_change_budget_usd=0.5)
    c = final(run(client, "T1"))
    assert c["status"] == "stopped" and c["stopped_reason"] == "budget"
    assert len(commits(svc)) == 1 and svc._running is None
    assert client.get("/api/software-factory/state", headers=LAB).json()["running"] is None
    # The factory is free again.
    svc.make_agent = lambda role, model, root, mode, effort, emit: FakeAgent(
        role, root, {"planner": plan("README.md"), "implementer": add_readme, "reviewer": PASS}, [])
    assert final(run(client, "T1"))["status"] == "merged"


# ----- people, reverts and limits -----

def test_a_revert_records_an_escape_and_costs_the_area_a_level(tmp_path: Path, project: Path) -> None:
    client, svc, _ = lab(tmp_path, {"planner": plan("README.md"), "implementer": add_readme, "reviewer": PASS})
    c = final(run(client, "T1"))
    r = client.post(f"/api/software-factory/changes/{c['id']}/revert", headers=LAB, json={"note": "Wrong command."})
    assert r.status_code == 200 and r.json()["status"] == "reverted"
    assert commits(svc)[0].startswith("Revert")
    led = client.get("/api/software-factory/state", headers=LAB).json()["ledger"]["docs"]
    assert led["escapes"] == 1 and led["level"] == 0
    # On probation, even low-risk docs work now waits for a person.
    t1 = next(t for t in client.get("/api/software-factory/state", headers=LAB).json()["tickets"] if t["id"] == "T1")
    assert t1["effective_tier"] == "medium"
    assert client.post(f"/api/software-factory/changes/{c['id']}/revert", headers=LAB, json={}).status_code == 400


def test_three_clean_changes_earn_trust_so_medium_work_runs_dark(tmp_path: Path, project: Path) -> None:
    client, svc, _ = lab(tmp_path, {"planner": plan("README.md"), "implementer": add_readme, "reviewer": PASS})
    for _ in range(P.PROMOTE_AFTER):  # each run rewrites the same README, which is still a clean change
        svc.make_agent = lambda role, model, root, mode, effort, emit: FakeAgent(role, root, {
            "planner": plan("README.md"), "reviewer": PASS,
            "implementer": lambda r, p, n: ((r / "README.md").write_text(f"# Calc {time.time()}\n"), "Done.")[1]},
            [])
        assert final(run(client, "T1"))["status"] == "merged"
    state = client.get("/api/software-factory/state", headers=LAB).json()
    assert state["ledger"]["docs"]["level"] == 2 and state["metrics"]["dark_share"] == 1.0


def test_two_changes_at_once_are_refused(tmp_path: Path, project: Path) -> None:
    client, svc, _ = lab(tmp_path, {"planner": plan("ledger/calc.py"), "implementer": fix_sub, "reviewer": PASS})
    seen: dict[str, Any] = {}

    def answer(client: TestClient, svc: Any, w: dict) -> None:
        r = client.post("/api/software-factory/changes", headers=LAB, json={"ticket_id": "T1", "model": HAIKU})
        seen["second"] = r.status_code
        assert client.post(f"/api/software-factory/changes/{svc.state()['changes'][0]['id']}/revert", headers=LAB,
                           json={}).status_code == 409
        decide("approve")(client, svc, w)

    assert final(run(client, "T6", answer, svc))["status"] == "merged"
    assert seen["second"] == 409


def test_stop_ends_a_waiting_change(tmp_path: Path, project: Path) -> None:
    client, svc, _ = lab(tmp_path, {"planner": plan("ledger/calc.py"), "implementer": fix_sub, "reviewer": PASS})

    def answer(client: TestClient, svc: Any, w: dict) -> None:
        assert client.post(f"/api/software-factory/runs/{w['run_id']}/stop", headers=LAB).status_code == 204

    c = final(run(client, "T6", answer, svc))
    assert c["status"] == "stopped" and c["stopped_reason"] == "stopped"


def test_decisions_are_validated_and_only_the_first_answer_counts(tmp_path: Path, project: Path) -> None:
    client, svc, _ = lab(tmp_path, {"planner": plan("ledger/calc.py"), "implementer": fix_sub, "reviewer": PASS})
    codes: dict[str, int] = {}

    def answer(client: TestClient, svc: Any, w: dict) -> None:
        body = {"run_id": w["run_id"], "decision_id": w["id"]}
        codes["no_note"] = client.post("/api/software-factory/decide", headers=LAB,
                                       json={**body, "decision": "reject"}).status_code
        codes["bad"] = client.post("/api/software-factory/decide", headers=LAB,
                                   json={**body, "decision": "merge"}).status_code
        codes["wrong_run"] = client.post("/api/software-factory/decide", headers=LAB,
                                         json={**body, "run_id": "x", "decision": "approve"}).status_code
        codes["first"] = client.post("/api/software-factory/decide", headers=LAB,
                                     json={**body, "decision": "approve"}).status_code
        codes["second"] = client.post("/api/software-factory/decide", headers=LAB,
                                      json={**body, "decision": "reject", "note": "no"}).status_code

    assert final(run(client, "T6", answer, svc))["status"] == "merged"
    assert codes == {"no_note": 400, "bad": 400, "wrong_run": 404, "first": 204, "second": 404}


def test_inputs_are_validated(tmp_path: Path, project: Path) -> None:
    client, svc, _ = lab(tmp_path, {})
    post = lambda body: client.post("/api/software-factory/changes", headers=LAB, json=body)  # noqa: E731
    assert post({"ticket_id": "nope", "model": HAIKU}).status_code == 404
    assert post({"ticket_id": "T1", "model": "gpt-zero"}).status_code == 400
    assert post({"ticket_id": "T1", "model": HAIKU, "effort": "huge"}).status_code == 400
    t = client.post("/api/software-factory/tickets", headers=LAB,
                    json={"title": "Add a total row", "description": "Show a grand total under the report.",
                          "kind": "feature", "area": "reporting"})
    assert t.status_code == 200 and t.json()["id"] == "U1" and t.json()["tier"] == "medium"
    assert client.post("/api/software-factory/tickets", headers=LAB,
                       json={"title": "x", "description": "short", "kind": "feature", "area": "reporting"}
                       ).status_code == 400
    assert client.post("/api/software-factory/tickets", headers=LAB,
                       json={"title": "A fine title", "description": "Long enough description here.",
                             "kind": "rewrite", "area": "reporting"}).status_code == 400
    assert client.post("/api/software-factory/changes", json={"ticket_id": "T1", "model": HAIKU}).status_code == 403


def test_no_sandbox_refuses_to_start(tmp_path: Path, project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, svc, _ = lab(tmp_path, {})
    svc.sandbox = None
    monkeypatch.setattr(F.C, "SANDBOX", None)
    r = client.post("/api/software-factory/changes", headers=LAB, json={"ticket_id": "T1", "model": HAIKU})
    assert r.status_code == 409 and "sandbox" in r.json()["error"]["message"]
    assert client.get("/api/software-factory/info", headers=LAB).json()["sandbox"]["available"] is False


# ----- code review fixes -----

def test_review_1_nothing_the_agent_writes_can_make_git_run_a_program(tmp_path: Path, project: Path) -> None:
    """The agent writes a pre-commit hook, an fsmonitor setting and a link into its tree: none of it reaches git."""
    marker = tmp_path / "pwned"
    hook = f"#!/bin/sh\ntouch {marker}\n"

    def implement(root: Path, prompt: str, n: int) -> str:
        assert not (root / ".git").exists()  # the agent's tree has no repository at all
        (root / ".git" / "hooks").mkdir(parents=True)
        (root / ".git" / "hooks" / "pre-commit").write_text(hook)
        (root / ".git" / "hooks" / "pre-commit").chmod(0o755)
        (root / ".git" / "monitor.sh").write_text(hook)
        (root / ".git" / "monitor.sh").chmod(0o755)
        (root / ".git" / "config").write_text(f"[core]\n\tfsmonitor = {root / '.git' / 'monitor.sh'}\n"
                                              f"\thooksPath = {root / '.git' / 'hooks'}\n")
        (root / "linked.txt").symlink_to(tmp_path / "template" / "CLAUDE.example.md")
        return add_readme(root, prompt, n)

    client, svc, _ = lab(tmp_path, {"planner": plan("README.md"), "implementer": implement, "reviewer": PASS})
    c = final(run(client, "T1"))
    assert c["status"] == "merged" and not marker.exists()
    files = svc.change(c["id"])["files"]
    assert files == ["README.md"]  # no .git file and no link became part of the change
    _, tracked = F.git(["ls-files"], svc.project)
    assert not any(line.startswith(".git/") for line in tracked.splitlines()) and "linked.txt" not in tracked
    assert any(a["what"] == "left out of the change" for a in svc.change(c["id"])["audit"])


def test_review_1_git_itself_runs_no_hooks_or_fsmonitor(tmp_path: Path) -> None:
    """Even in a repository that carries a hook and an fsmonitor setting, the factory's git runs neither."""
    marker = tmp_path / "ran"
    repo = tmp_path / "r"
    repo.mkdir()
    assert F.git(["init", "-q"], repo)[0] == 0
    script = repo / ".git" / "hooks" / "pre-commit"
    script.write_text(f"#!/bin/sh\ntouch {marker}\n")
    script.chmod(0o755)
    monitor = tmp_path / "monitor.sh"
    monitor.write_text(f"#!/bin/sh\ntouch {marker}\n")
    monitor.chmod(0o755)
    with (repo / ".git" / "config").open("a") as f:
        f.write(f"[core]\n\tfsmonitor = {monitor}\n")
    (repo / "a.txt").write_text("a")
    F.git(["add", "-A"], repo)
    F.git(["status"], repo)
    assert F.git(["commit", "-qm", "x"], repo)[0] == 0
    assert not marker.exists()


def test_review_2_a_trusted_area_still_waits_for_a_person_when_the_diff_edits_tests(tmp_path: Path,
                                                                                    project: Path) -> None:
    def implement(root: Path, prompt: str, n: int) -> str:
        fix_sub(root, prompt, n)
        (root / "tests" / "test_calc.py").write_text(TESTS + "\n    def test_sub_negative(self):\n"
                                                     "        self.assertEqual(sub(1, 3), -2)\n")
        return "Fixed sub and added a test."

    client, svc, _ = lab(tmp_path, {"planner": plan("ledger/calc.py"), "implementer": implement, "reviewer": PASS})
    svc._update_ledger(lambda led: led["areas"]["parsing"].update({"level": 2}))
    ev = run(client, "T2", decide("approve"), svc)  # a bugfix in parsing: declared low
    c = final(ev)
    assert [e["kind"] for e in ev if e["type"] == "decision_needed"] == ["diff"]
    assert c["status"] == "merged" and c["dark"] is False and c["effective_tier"] == "medium"


def test_review_3_effort_is_checked_against_the_model_before_anything_starts(tmp_path: Path, project: Path,
                                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    client, svc, _ = lab(tmp_path, {"planner": plan("README.md"), "implementer": add_readme, "reviewer": PASS})
    r = client.post("/api/software-factory/changes", headers=LAB,
                    json={"ticket_id": "T1", "model": HAIKU, "effort": "huge"})
    assert r.status_code == 400 and "takes effort" in r.json()["error"]["message"]
    assert svc.state()["changes"] == [] and not svc.project.exists()  # nothing cloned, nothing recorded
    assert client.get("/api/software-factory/info", headers=LAB).json()["efforts"][HAIKU][-1] == "max"
    # A model that takes no effort setting refuses one.
    svc.models = lambda: [HAIKU, "local-model"]  # type: ignore[method-assign]
    monkeypatch.setattr(F, "efforts_for", lambda m: [] if m == "local-model" else ["low", "medium", "high"])
    r = client.post("/api/software-factory/changes", headers=LAB,
                    json={"ticket_id": "T1", "model": "local-model", "effort": "low"})
    assert r.status_code == 400 and "no effort" in r.json()["error"]["message"]
