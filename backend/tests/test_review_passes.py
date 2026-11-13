"""The review-passes lab: the answer key, the scoring and each mode, with a scripted model (no key, no cost)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.gateways.claude import ClaudeGateway
from backend.app.main import create_app
from backend.app.services import review_passes as rp
from backend.app.services.review_passes_code import FILES, FIXED_STORE, numbered
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB


def at(key_id: str, **extra) -> dict:
    """A finding that points at a real problem in the key."""
    k = next(k for k in rp.KEY if k["id"] == key_id)
    f, line, _ = rp.locate(k["places"][0])
    return {"file": f, "line": line, "severity": k["severity"], "issue": key_id, "detected_pattern": key_id, **extra}


def noise(noise_id: str, **extra) -> dict:
    n = next(n for n in rp.NOISE if n["id"] == noise_id)
    f, line, _ = rp.locate(n["places"][0])
    return {"file": f, "line": line, "severity": "bug", "issue": noise_id, "detected_pattern": noise_id, **extra}


def reply(*findings: dict) -> list[dict]:
    return [text(json.dumps({"findings": list(findings)}))]


def service(script: list[list[dict]]) -> tuple[rp.ReviewPassesService, ScriptedClient]:
    fake = ScriptedClient(script)
    return rp.ReviewPassesService(ClaudeGateway(fake), SpendTracker(1.0)), fake


def test_every_place_in_the_key_exists_and_the_change_set_is_the_size_it_says() -> None:
    for item in [*rp.KEY, *rp.NOISE]:
        for place in item["places"]:
            name, first, last = rp.locate(place)
            assert 1 <= first <= last <= len(FILES[name].splitlines())
    assert len(FILES) == 5 and len(rp.KEY) == 6
    assert sum(k["cross_file"] for k in rp.KEY) == 1
    assert {k["severity"] for k in rp.KEY} >= {"bug", "security", "data-loss"}
    assert "  1 | " in numbered(FILES) and "=== refunds/service.py" in numbered(FILES)


def test_the_fixed_store_only_changes_the_sql() -> None:
    assert "{customer_ref}" in FILES["refunds/store.py"] and "{customer_ref}" not in FIXED_STORE
    assert len(FILES["refunds/store.py"].splitlines()) == len(FIXED_STORE.splitlines())  # line numbers stay put


def test_the_schema_matches_the_ci_schema_file() -> None:
    ci = json.loads((Path(__file__).parents[2] / "examples" / "claude-code" / "ci" / "review-schema.json").read_text())
    assert rp.SCHEMA == ci
    plain = rp.findings_schema()["properties"]["findings"]["items"]
    assert "status" not in plain["properties"] and "detected_pattern" in plain["required"]
    assert "confidence" in rp.findings_schema(confidence=True)["properties"]["findings"]["items"]["required"]


def test_scoring_counts_found_missed_noise_duplicates_and_unknowns() -> None:
    cross = {**at("units"), "file": "refunds/service.py", "line": rp.locate(rp.KEY[0]["places"][2])[1]}
    got = rp.score([at("sql"), cross, at("units"), noise("unused_import"), noise("assert"),
                    {"file": "refunds/models.py", "line": 3, "severity": "bug", "issue": "x"}])
    assert got["found"] == ["units", "sql"] and got["duplicates"] == 1
    assert got["noise_hits"] == 2 and got["false_positives"] == 3
    assert got["precision"] == 0.4 and got["recall"] == 0.33
    assert "delete_first" in got["missed"]
    assert rp.score([])["precision"] is None


def test_contradictions_are_the_same_place_with_two_severities() -> None:
    a, b = at("units"), {**at("units"), "severity": "security", "issue": "other"}
    assert len(rp.contradictions([a, b])) == 1 and rp.contradictions([a, a]) == []


def test_routing_and_dismissed_patterns() -> None:
    lanes = rp.route([{"confidence": 0.95}, {"confidence": 0.8}, {"confidence": 0.6}, {"confidence": 0.2}, {}])
    assert [len(lanes[k]) for k in ("comment", "triage", "log")] == [2, 1, 2]
    rows = rp.score([noise("todo", detected_pattern="TODO comment"), noise("naming", detected_pattern="todo comment"),
                     at("sql")])["findings"]
    assert rp.dismissed_patterns(rows) == [{"pattern": "todo comment", "count": 2}]


def test_criteria_runs_two_reviews_and_scores_them() -> None:
    svc, fake = service([reply(at("sql"), noise("unused_import"), noise("todo")),
                         reply(at("sql"), at("delete_first"), at("units"))])
    out = svc.criteria("claude-haiku-5-5")["variants"]
    vague, explicit = out
    assert vague["false_positives"] == 2 and vague["precision"] == 0.33
    assert explicit["found"] == ["units", "sql", "delete_first"] and explicit["precision"] == 1.0
    assert explicit["cost_usd"] > 0 and explicit["tokens_in"] == 1000 and explicit["calls"] == 1
    assert fake.calls[0][1]["system"] == rp.VAGUE and fake.calls[1][1]["system"] == rp.EXPLICIT
    assert fake.calls[1][1]["output_config"]["format"]["type"] == "json_schema"
    assert "  1 | " in fake.calls[0][1]["messages"][0]["content"]


def test_passes_split_the_files_then_read_across_them() -> None:
    cross = {**at("units"), "file": "refunds/service.py", "line": rp.locate(rp.KEY[0]["places"][2])[1]}
    script = [reply(at("sql"))]  # one pass: misses the cross-file bug
    script += [reply()] * 5 + [reply(at("sql", severity="bug"))]  # five per-file passes, then the integration pass
    script[-1] = reply(cross)
    script[3] = reply(at("sql"), {**at("sql"), "severity": "bug"})  # the store file's pass is unsure what kind it is
    svc, fake = service(script)
    single, split = svc.passes(None)["variants"]
    assert "units" not in single["found"] and "units" in split["found"]
    assert split["calls"] == 6 and len(split["steps"]) == 6 and len(single["steps"]) == 1
    assert len(split["contradictions"]) == 1
    assert "one file only" in fake.calls[1][1]["system"] and "refunds/models.py" not in fake.calls[2][1]["messages"][0]["content"]
    assert "across files" in fake.calls[6][1]["system"] and "refunds/models.py" in fake.calls[6][1]["messages"][0]["content"]


def test_independent_review_does_not_see_the_explanation() -> None:
    svc, fake = service([[text("It all looks right.")], reply(), reply(at("retry"))])
    own, fresh = svc.independent("claude-haiku-5-5")["variants"]
    assert own["found"] == [] and fresh["found"] == ["retry"] and own["calls"] == 2 and fresh["calls"] == 1
    assert own["explanation"] == "It all looks right."
    review_turn = fake.calls[1][1]["messages"]
    assert [m["role"] for m in review_turn] == ["user", "assistant", "user"] and review_turn[1]["content"] == "It all looks right."
    assert len(fake.calls[2][1]["messages"]) == 1  # no history


def test_confidence_routes_findings_and_groups_the_dismissed() -> None:
    svc, fake = service([reply(at("sql", confidence=0.95), at("window", confidence=0.6),
                               noise("todo", confidence=0.3, detected_pattern="TODO comment"),
                               noise("naming", confidence=0.85, detected_pattern="misspelt name"))])
    out = svc.confidence(None)
    lanes = {r["lane"]: r for r in out["routing"]}
    assert (lanes["comment"]["real"], lanes["comment"]["dismissed"]) == (1, 1)
    assert (lanes["triage"]["real"], lanes["triage"]["dismissed"]) == (1, 0)
    assert (lanes["log"]["real"], lanes["log"]["dismissed"]) == (0, 1)
    assert {p["pattern"] for p in out["dismissed_patterns"]} == {"todo comment", "misspelt name"}
    assert "confidence" in fake.calls[0][1]["output_config"]["format"]["schema"]["properties"]["findings"]["items"]["required"]


def test_ci_rerun_gets_the_first_findings_and_the_fixed_file() -> None:
    first = [{**at("sql"), "status": "new"}, {**at("retry"), "status": "new"}]
    second = [{**at("retry"), "status": "still_open"}, {**at("window"), "status": "new"}]
    svc, fake = service([reply(*first), reply(*second)])
    out = svc.ci(None)
    assert out["fixed"] == ["sql"] and out["still_open"] == ["retry"]
    rerun = fake.calls[1][1]["messages"][0]["content"]
    assert "Previous findings" in rerun and "{customer_ref}" not in rerun and "customer_ref = ?" in rerun
    rows = out["second"]["findings"]
    assert [r["status_ok"] for r in rows] == [True, True]
    assert fake.calls[1][1]["output_config"]["format"]["schema"] == rp.SCHEMA


def test_info_shows_the_key_and_the_files() -> None:
    svc, _ = service([])
    info = svc.info()
    assert len(info["files"]) == 5 and len(info["key"]) == 6 and info["key"][0]["where"][0].startswith("refunds/policy.py:")


def _wired() -> bool:
    init = Path(__file__).parents[1] / "app" / "api" / "__init__.py"
    return "review_passes" in init.read_text()


@pytest.mark.skipif(not _wired(), reason="route not wired yet")
def test_routes_check_the_guards_and_run_a_mode(tmp_path: Path) -> None:
    fake = ScriptedClient([reply(at("sql")), reply(at("sql"), at("retry"))])
    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    assert len(client.get("/api/review-passes/info", headers=LAB).json()["files"]) == 5
    r = client.post("/api/review-passes/criteria", headers=LAB, json={"model": "claude-haiku-5-5"})
    assert r.status_code == 200 and r.json()["variants"][1]["found"] == ["sql", "retry"]
    assert client.post("/api/review-passes/criteria", json={}).status_code in (400, 403)
    assert client.post("/api/review-passes/criteria", headers=LAB, json={"model": "gpt-nope"}).status_code == 400


def test_a_contradiction_is_one_problem_given_two_severities_not_two_problems_close_together() -> None:
    from backend.app.services.review_passes import FILES, contradictions

    def line_of(file: str, text: str) -> int:
        return next(i for i, l in enumerate(FILES[file].splitlines(), 1) if text in l)

    sql = line_of("refunds/store.py", "WHERE o.customer_ref = '{customer_ref}'")
    same = [{"file": "refunds/store.py", "line": sql, "severity": "security", "issue": "injection"},
            {"file": "refunds/store.py", "line": sql, "severity": "bug", "issue": "string SQL"}]
    assert len(contradictions(same)) == 1
    delete = line_of("refunds/service.py", "self.store.delete_pending(order.id)")
    request = line_of("refunds/service.py", "request = RefundRequest(")
    different = [{"file": "refunds/service.py", "line": delete, "severity": "data-loss", "issue": "deleted first"},
                 {"file": "refunds/service.py", "line": request, "severity": "bug", "issue": "pounds as pence"}]
    assert contradictions(different) == []
