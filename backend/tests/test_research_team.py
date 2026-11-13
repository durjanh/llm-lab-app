"""Research team: the corpus, failure handling, provenance checks, manifest and resume, parallel delegation, and one
scripted coordinator run. No network and no cost."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from backend.app.core.errors import ApiError
from fastapi.testclient import TestClient

from backend.app.gateways.claude import ClaudeGateway
from backend.app.services import research_team as rt
from backend.app.services.research_team import (
    AGENTS, Corpus, Manifest, ResearchTeamService, attach_source, build_prompt, check_provenance, classify_difference,
    compare_figures, compute_coverage, error_context, evidence_in_source, run_parallel)
from backend.app.services.runs import RunRegistry, RunStreamer
from backend.app.services.spend import SpendTracker
from backend.tests.test_aftercare import ScriptedClient, reply, text, use
from backend.tests.test_api import LAB, FakeClient

HAIKU = "claude-haiku-5-5"


# ---------- the corpus ----------

def test_the_corpus_has_the_cases_the_lab_needs() -> None:
    assert len(rt.SOURCES) == 14 and len({s["id"] for s in rt.SOURCES}) == 14
    assert all(s["title"] and s["publisher"] and s["date"] and s["text"] for s in rt.SOURCES)
    by = rt.SOURCES_BY_ID
    assert "98,000" in by["S01"]["text"] and "112,000" in by["S02"]["text"]  # two credible, conflicting figures
    assert "13,000" in by["S03"]["text"] and "11,200" in by["S04"]["text"]  # old and new, different years


def test_search_finds_sources_and_a_valid_empty_result_is_not_an_error() -> None:
    corpus = Corpus()
    hits = corpus.search("installations 2024")
    assert {r["source_id"] for r in hits["results"]} >= {"S01", "S02"} and "error" not in hits
    assert corpus.search("Boiler Upgrade Scheme grant")["results"][0]["source_id"] == "S06"
    empty = corpus.search("hydrogen boilers")
    assert empty["count"] == 0 and empty["results"] == [] and "valid empty result" in empty["note"]
    assert "error" not in empty
    assert corpus.search("the of and")["count"] == 0  # only stop words


def test_a_transient_failure_works_on_the_second_try_and_a_permanent_one_never_does() -> None:
    corpus = Corpus()
    first = corpus.fetch("S10")
    assert first["error"]["failure_type"] == "timeout" and first["error"]["transient"] is True
    assert corpus.fetch("S10")["source"]["id"] == "S10"
    for _ in range(3):
        err = corpus.fetch("S11")["error"]
        assert err["failure_type"] == "access_denied" and err["transient"] is False
    assert corpus.fetch("S99")["error"]["failure_type"] == "not_found"
    assert corpus.fetch("s01")["source"]["publisher"] == "Kestrel Energy Research"


def test_the_structured_error_has_the_four_fields_the_coordinator_needs() -> None:
    e = error_context("access_denied", "fetch_source(S11)", [{"source_id": "S01"}], [{"source_id": "S04"}], "refused")
    assert set(e) == {"failure_type", "attempted_query", "partial_results", "alternatives", "message"}


# ---------- findings, figures, provenance ----------

def test_evidence_must_be_in_the_source_and_metadata_comes_from_code() -> None:
    assert evidence_in_source("98,000 heat pump installations in Great Britain in 2024", "S01")
    assert evidence_in_source("98,000  HEAT pump installations", "S01")
    assert not evidence_in_source("120,000 installations", "S01") and not evidence_in_source("", "S01")
    f = attach_source({"claim": "98,000 installed", "evidence": "98,000", "source_id": "S01"})
    assert (f["title"], f["publisher"], f["date"]) == (rt.SOURCES_BY_ID["S01"]["title"], "Kestrel Energy Research",
                                                       "2025-02-10")


def test_older_against_newer_is_a_time_difference_not_a_conflict() -> None:
    old = {"measure": "cost", "value": 13000, "year": 2022, "source_id": "S03"}
    new = {"measure": "cost", "value": 11200, "year": 2025, "source_id": "S04"}
    assert classify_difference(old, new) == "time_difference"
    assert classify_difference({"value": 98000, "year": 2024}, {"value": 112000, "year": 2024}) == "conflict"
    assert classify_difference(old, {**old, "source_id": "S99"}) == "agree"
    out = compare_figures([old, new, {"measure": "Cost", "value": 11200, "year": 2025, "source_id": "S04"},
                           {"measure": "solo", "value": 1, "year": 2024, "source_id": "S01"}])
    assert len(out) == 1 and out[0]["relation"] == "time_difference"
    assert [s["year"] for s in out[0]["sides"]] == [2022, 2025]  # older first


FINDINGS = [attach_source(f) for f in (
    {"claim": "98,000 installed in 2024", "evidence": "98,000 heat pump installations", "source_id": "S01"},
    {"claim": "112,000 installed in 2024", "evidence": "112,000 heat pumps sold and fitted", "source_id": "S02"},
)]


def test_provenance_keeps_conflicting_figures_side_by_side_with_sources() -> None:
    good = {"claims": [{"sub_question_id": "q1", "claim": "Kestrel counts 98,000 and Ridgeway 112,000 for 2024",
                        "source_ids": ["S01", "S02"], "status": "contested"}],
            "conflicts": [{"measure": "installs", "sides": [{"source_id": "S01", "value": "98,000"},
                                                            {"source_id": "S02", "value": "112,000"}]}]}
    assert check_provenance(FINDINGS, good) == []
    bad = {"claims": [
        {"claim": "About 105,000 were installed", "source_ids": ["S01"], "status": "established"},  # invented figure
        {"claim": "Something", "source_ids": [], "status": "established"},
        {"claim": "Cited but never found", "source_ids": ["S09"], "status": "single_source"},
        {"claim": "Disputed 98,000", "source_ids": ["S01"], "status": "contested"}],
        "conflicts": [{"measure": "installs", "sides": [{"source_id": "S01", "value": "98,000"}]}]}
    kinds = [i["kind"] for i in check_provenance(FINDINGS, bad)]
    assert kinds.count("unsupported_figure") == 1
    assert {"no_source", "unknown_source", "contested_one_source", "conflict_dropped_side"} <= set(kinds)


def test_coverage_marks_gaps_and_names_the_sources_that_could_not_be_read() -> None:
    sqs = [{"id": "q1", "text": "installs"}, {"id": "q2", "text": "price effect"}, {"id": "q3", "text": "cost"}]
    synthesis = {"claims": [{"sub_question_id": "q1", "claim": "x", "source_ids": ["S01", "S02"], "status": "contested"},
                            {"sub_question_id": "q3", "claim": "y", "source_ids": ["S04"], "status": "single_source"}],
                 "gaps": [{"sub_question_id": "q2", "reason": "the only source was unavailable"}]}
    cov = {c["id"]: c for c in compute_coverage(sqs, FINDINGS, synthesis, [
        {"source_id": "S11", "failure_type": "access_denied"}])}
    assert cov["q1"]["status"] == "contested" and cov["q3"]["status"] == "supported"
    assert cov["q2"]["status"] == "gap" and "S11 (access_denied)" in cov["q2"]["note"]


def test_a_subagent_prompt_carries_the_prior_findings_in_full() -> None:
    prior = [({"id": "a1", "agent": "search", "task": "find installs"}, {"findings": FINDINGS, "errors": [error_context(
        "access_denied", "fetch_source(S11)", [], [])], "empty_queries": ["hydrogen"], "summary": "two found"})]
    prompt = build_prompt("How many?", [{"id": "q1", "text": "installs in 2024"}], "Combine them", prior)
    for needle in ("Task: Combine them", "How many?", "q1: installs in 2024", "[S01]", "98,000 heat pump installations",
                   "Kestrel Energy Research, 2025-02-10", "[S02]", "access_denied", "valid empty result"):
        assert needle in prompt
    assert "Prior results: none" in build_prompt("q", [], "t", [])


def test_subagent_definitions_scope_the_tools() -> None:
    assert AGENTS["search"]["tools"] == ["search_corpus", "fetch_source"]
    assert AGENTS["synthesis"]["tools"] == ["verify_claim"]  # it cannot search
    assert AGENTS["analysis"]["tools"] == [] and AGENTS["report"]["tools"] == []
    for a in rt.agent_definitions():
        assert set(a) == {"name", "description", "prompt", "tools", "submit_tool"} and "no memory" in a["prompt"]


# ---------- parallel delegation ----------

def test_parallel_calls_take_the_longest_time_not_the_sum() -> None:
    def slow(i: int) -> Any:
        def fn() -> int:
            time.sleep(0.25)
            return i
        return fn

    results, wall, total = run_parallel([slow(1), slow(2), slow(3)])
    assert results == [1, 2, 3]
    assert total >= 0.7 and wall < 0.55 and wall < total


def test_parallel_runs_finish_every_call_before_raising_the_first_failure() -> None:
    done: list[int] = []

    def ok() -> None:
        time.sleep(0.1)
        done.append(1)

    def boom() -> None:
        raise ValueError("boom")

    with pytest.raises(ValueError):
        run_parallel([boom, ok])
    assert done == [1]


# ---------- manifest ----------

def test_the_manifest_is_written_and_loaded_back(tmp_path: Path) -> None:
    m = Manifest.create(tmp_path, "abc123abc123", "Q?", HAIKU)
    step = m.add_step("search", "find installs", [], rt._key("search", "find installs", []))
    assert m.data["steps"][0]["status"] == "running" and step["id"] == "a1"
    m.finish_step(step, {"agent": "search", "status": "ok", "findings": FINDINGS, "summary": "s"}, 1.234)
    loaded = Manifest.load(tmp_path, "abc123abc123")
    s = loaded.data["steps"][0]
    assert s["status"] == "done" and s["findings_file"] == "a1_search.json" and s["seconds"] == 1.23
    assert loaded.result_of(s)["findings"][0]["source_id"] == "S01"
    assert loaded.find_done(rt._key("search", "find   INSTALLS", [])) is s  # keys ignore case and spacing
    with pytest.raises(rt.ApiError):
        Manifest.load(tmp_path, "../../etc/passwd")


# ---------- running the service ----------

def make(tmp_path: Path, client: FakeClient, parallel: bool = False) -> ResearchTeamService:
    return ResearchTeamService(ClaudeGateway(client), SpendTracker(5.0), tmp_path,
                               RunStreamer(RunRegistry(), 5.0), parallel=parallel)


def events_of(service: ResearchTeamService, *args: Any, **kwargs: Any) -> list[dict]:
    return [json.loads(line) for line in service.run(*args, **kwargs) if line.strip()]


def of(events: list[dict], type_: str) -> list[dict]:
    return [e for e in events if e["type"] == type_]


SQ = {"subquestions": [{"id": "q1", "text": "How many heat pumps were installed in 2024?"}]}
EVIDENCE_1 = "98,000 heat pump installations in Great Britain in 2024"
EVIDENCE_2 = "112,000 heat pumps sold and fitted in Great Britain in 2024"


def conflict_script() -> list[list[dict]]:
    """A coordinator and its search agent for the 2024 install question, where two sources differ."""
    return [
        [use("set_subquestions", SQ)],
        [use("delegate", {"agent": "search", "task": "Find 2024 installation counts"})],
        [use("search_corpus", {"query": "installations 2024"})],
        [use("fetch_source", {"source_id": "S01"}, 1), use("fetch_source", {"source_id": "S02"}, 2)],
        [use("submit_findings", {"findings": [
            {"claim": "98,000 installed in 2024", "evidence": EVIDENCE_1, "source_id": "S01", "sub_question": "q1"},
            {"claim": "112,000 installed in 2024", "evidence": EVIDENCE_2, "source_id": "S02", "sub_question": "q1"},
            {"claim": "Made-up", "evidence": "a figure nobody printed", "source_id": "S01"},
            {"claim": "From a source it never read", "evidence": "x", "source_id": "S09"}],
            "summary": "Two sources, two figures."})],
        [use("delegate", {"agent": "synthesis", "task": "Combine", "include_results": ["a1"]})],
        [use("submit_synthesis", {"claims": [{"sub_question_id": "q1", "claim": "Kestrel says 98,000 and Ridgeway "
                                                                               "says 112,000 for 2024",
                                              "source_ids": ["S01", "S02"], "status": "contested"}],
                                  "conflicts": [{"measure": "installs 2024", "sides": [
                                      {"source_id": "S01", "value": "98,000"}, {"source_id": "S02", "value": "112,000"}],
                                      "explanation": "Both are 2024 counts"}], "gaps": []})],
        [use("delegate", {"agent": "report", "task": "Write it up", "include_results": ["a2"]})],
        [use("submit_report", {"title": "Heat pump installs", "summary": "Sources differ.", "sections": [
            {"heading": "2024 installs", "kind": "table", "status": "contested", "columns": ["Source", "Count"],
             "rows": [["S01", "98,000"], ["S02", "112,000"]], "source_ids": ["S01", "S02"]}]})],
        [use("finish", {"answer": "Done."})],
    ]


def test_a_scripted_coordinator_run_end_to_end(tmp_path: Path) -> None:
    client = ScriptedClient(conflict_script())
    service = make(tmp_path, client)
    events = events_of(service, "How many heat pumps were installed in 2024?", HAIKU, 1.0)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "run" and events[-1]["type"] == "done" and events[-1]["status"] == "done"
    assert of(events, "subquestions")[0]["items"][0]["id"] == "q1"
    # the search agent started with an empty context: only its own definition and the task
    start = of(events, "agent_start")[0]
    assert start["agent"] == "search" and start["tools"] == ["search_corpus", "fetch_source", "submit_findings"]
    assert "Prior results: none" in start["prompt"] and "Find 2024 installation counts" in start["prompt"]
    # the synthesis agent's prompt carries the whole of the search result
    synth = [e for e in of(events, "agent_start") if e["agent"] == "synthesis"][0]
    assert "98,000 heat pump installations" in synth["prompt"] and "[S02]" in synth["prompt"]
    assert synth["tools"] == ["verify_claim", "submit_synthesis"]
    # invented or unread evidence is rejected; the two real findings carry code-attached metadata
    a1 = [e for e in of(events, "agent_done") if e["step"] == "a1"][0]["result"]
    assert [f["source_id"] for f in a1["findings"]] == ["S01", "S02"] and len(a1["rejected"]) == 2
    assert a1["findings"][0]["publisher"] == "Kestrel Energy Research" and a1["status"] == "ok"
    # the conflict is kept, with both sources, and the report shows a table
    report = of(events, "report")[0]
    assert report["sections"][0]["kind"] == "table" and {s["id"] for s in report["cited_sources"]} == {"S01", "S02"}
    assert report["issues"] == [] and report["unknown_citations"] == []
    assert report["coverage"][0]["status"] == "contested"
    assert events[-1]["spent_usd"] > 0 and events[-1]["model_calls"] == 10 and not client.script
    # tool calls are scoped: the coordinator was given only its three tools
    assert [t["name"] for t in client.calls[0][1]["tools"]] == ["set_subquestions", "delegate", "finish"]
    assert [t["name"] for t in client.calls[2][1]["tools"]] == [
        "search_corpus", "fetch_source", "submit_findings"]
    # the manifest records every step with its findings file
    manifest = Manifest.load(tmp_path / "research-team", of(events, "started")[0]["run_id"])
    assert [(s["agent"], s["status"]) for s in manifest.data["steps"]] == [
        ("search", "done"), ("synthesis", "done"), ("report", "done")]
    assert manifest.data["status"] == "done" and all((manifest.folder / s["findings_file"]).is_file()
                                                      for s in manifest.data["steps"])


def test_a_timeout_is_retried_inside_the_subagent_and_an_access_failure_goes_up_structured(tmp_path: Path) -> None:
    client = ScriptedClient([
        [use("set_subquestions", {"subquestions": [{"id": "q1", "text": "workforce"}, {"id": "q2", "text": "prices"}]})],
        [use("delegate", {"agent": "search", "task": "workforce and prices"})],
        [use("search_corpus", {"query": "installer workforce sale price"})],
        [use("fetch_source", {"source_id": "S10"}, 1), use("fetch_source", {"source_id": "S11"}, 2)],
        [use("submit_findings", {"findings": [{"claim": "4,300 certified installers", "source_id": "S10",
                                               "evidence": "4,300 certified heat pump installers"}],
                                 "summary": "S11 refused."})],
        [use("finish", {"answer": "Partial."})],
    ])
    events = events_of(make(tmp_path, client), "Workforce and sale prices?", HAIKU, 1.0)
    assert [r["attempt"] for r in of(events, "retry")] == [1]  # S10 timed out once, then worked
    fetches = [(e["input"]["source_id"], e["attempt"], e["ok"]) for e in of(events, "tool")
               if e["tool"] == "fetch_source"]
    assert ("S10", 1, False) in fetches and ("S10", 2, True) in fetches
    assert sum(1 for s, _, _ in fetches if s == "S11") == 1  # a permanent failure is not retried
    result = of(events, "agent_done")[0]["result"]
    assert result["status"] == "partial" and [f["source_id"] for f in result["findings"]] == ["S10"]
    [err] = result["errors"]
    assert err["failure_type"] == "access_denied" and err["attempted_query"] == "fetch_source(S11)"
    assert [p["source_id"] for p in err["partial_results"]] == ["S10"] and "alternatives" in err
    assert result["retries"][0]["failure_type"] == "timeout"
    assert events[-1]["status"] == "done"  # the run carried on with partial results


def test_an_empty_search_is_reported_as_empty_not_as_a_failure(tmp_path: Path) -> None:
    client = ScriptedClient([
        [use("set_subquestions", {"subquestions": [{"id": "q1", "text": "hydrogen boilers"}]})],
        [use("delegate", {"agent": "search", "task": "hydrogen boilers"})],
        [use("search_corpus", {"query": "hydrogen boilers"})],
        [use("submit_findings", {"findings": [], "summary": "Nothing in the corpus."})],
        [use("finish", {"answer": "No evidence."})],
    ])
    events = events_of(make(tmp_path, client), "What about hydrogen boilers?", HAIKU, 1.0)
    result = of(events, "agent_done")[0]["result"]
    assert result["status"] == "ok" and result["errors"] == [] and result["empty_queries"] == ["hydrogen boilers"]


def test_a_tool_outside_a_subagents_scope_is_refused(tmp_path: Path) -> None:
    client = ScriptedClient([
        [use("delegate", {"agent": "synthesis", "task": "Combine"})],
        [use("search_corpus", {"query": "installations"})],  # synthesis has no search
        [use("submit_synthesis", {"claims": []})],
        [use("finish", {"answer": "x"})],
    ])
    events = events_of(make(tmp_path, client), "Anything?", HAIKU, 1.0)
    refused = [e for e in of(events, "tool") if e["tool"] == "search_corpus"][0]
    assert refused["ok"] is False and refused["result"]["error"]["failure_type"] == "tool_not_available"


def test_a_crashed_run_resumes_and_redoes_only_the_unfinished_work(tmp_path: Path) -> None:
    first = ScriptedClient([
        [use("set_subquestions", SQ)],
        [use("delegate", {"agent": "search", "task": "Find 2024 installation counts"})],
        [use("search_corpus", {"query": "installations 2024"})],
        [use("fetch_source", {"source_id": "S01"})],
        [use("submit_findings", {"findings": [{"claim": "98,000 installed in 2024", "evidence": EVIDENCE_1,
                                               "source_id": "S01", "sub_question": "q1"}], "summary": "one"})],
        [use("delegate", {"agent": "synthesis", "task": "Combine", "include_results": ["a1"]})],  # crash here
    ])
    events = events_of(make(tmp_path, first), "How many installs?", HAIKU, 1.0, stop_after=1)
    run_id = of(events, "started")[0]["run_id"]
    assert of(events, "crashed") and events[-1]["status"] == "crashed"
    on_disk = json.loads((tmp_path / "research-team" / run_id / "manifest.json").read_text())
    assert [(s["agent"], s["status"]) for s in on_disk["steps"]] == [("search", "done"), ("synthesis", "running")]

    second = ScriptedClient([
        # code re-runs the interrupted synthesis itself, with its saved task and inputs
        [use("submit_synthesis", {"claims": [{"sub_question_id": "q1", "claim": "98,000 in 2024",
                                              "source_ids": ["S01"], "status": "single_source"}]})],
        [use("delegate", {"agent": "search", "task": "find 2024 installation counts"})],  # already done: no model call
        [use("finish", {"answer": "Done."})],
    ])
    service = make(tmp_path, second)
    assert service.runs()[0]["run_id"] == run_id and service.runs()[0]["unfinished"] == 1
    events = events_of(service, "", HAIKU, 1.0, resume_id=run_id)
    assert of(events, "started")[0]["resumed"] is True
    done = of(events, "agent_done")
    assert [(e["agent"], e["cached"]) for e in done] == [("synthesis", False), ("search", True)]
    assert done[1]["cost_usd"] == 0 and done[1]["result"]["findings"][0]["source_id"] == "S01"
    assert len(second.calls) == 3  # the search agent was not run again
    first_message = second.calls[1][1]["messages"][0]["content"]  # the coordinator's, after the synthesis re-run
    assert "resumed" in first_message and "a1 (search" in first_message and "a2 (synthesis" in first_message
    synth = [e for e in of(events, "agent_start")][0]
    assert "98,000 heat pump installations" in synth["prompt"]  # the cached findings still reached the subagent
    final = Manifest.load(tmp_path / "research-team", run_id)
    assert final.data["status"] == "done" and [s["status"] for s in final.data["steps"]] == ["done", "done"]


class ByAgent(FakeClient):
    """Answers each subagent's call after a delay, picking the reply from its system prompt; the coordinator is
    scripted. Used to show concurrent delegation."""

    def __init__(self, coordinator: list[list[dict]], delay: float = 0.3) -> None:
        super().__init__()
        self.coordinator, self.delay, self.lock = coordinator, delay, threading.Lock()

        def create(**params: Any) -> Any:
            self.calls.append(("messages.create", params))
            if "coordinator of a research team" in params["system"]:
                with self.lock:
                    blocks = self.coordinator.pop(0)
            else:
                time.sleep(self.delay)
                blocks = [use("submit_findings", {"findings": [], "summary": "none"})]
            return reply(params["model"], *blocks, stop="tool_use")

        self.messages.create = create  # type: ignore[method-assign]


def test_several_delegate_calls_in_one_turn_run_at_the_same_time(tmp_path: Path) -> None:
    client = ByAgent([
        [use("set_subquestions", {"subquestions": [{"id": "q1", "text": "a"}, {"id": "q2", "text": "b"},
                                                   {"id": "q3", "text": "c"}]}),
         use("delegate", {"agent": "search", "task": "grants"}, 1), use("delegate", {"agent": "search", "task": "cost"}, 2),
         use("delegate", {"agent": "search", "task": "carbon"}, 3)],
        [use("finish", {"answer": "ok"})],
    ])
    events = events_of(make(tmp_path, client, parallel=True), "Broad question?", HAIKU, 1.0)
    [p] = of(events, "parallel")
    assert p["agents"] == ["search"] * 3 and p["sum_s"] >= 0.85 and p["wall_s"] < 0.65 and p["saved_s"] > 0.3
    assert len(of(events, "agent_done")) == 3 and events[-1]["status"] == "done"


def test_refinement_after_synthesis_is_capped(tmp_path: Path) -> None:
    def search(i: int) -> list[list[dict]]:
        return [[use("delegate", {"agent": "search", "task": f"gap query {i}"})],
                [use("submit_findings", {"findings": [], "summary": "none"})]]

    client = ScriptedClient([
        [use("delegate", {"agent": "synthesis", "task": "Combine"})], [use("submit_synthesis", {"claims": []})],
        *search(1), *search(2),
        [use("delegate", {"agent": "search", "task": "gap query 3"})],  # refused: two rounds are used
        [use("finish", {"answer": "x"})],
    ])
    events = events_of(make(tmp_path, client), "Q?", HAIKU, 1.0)
    assert len(of(events, "agent_start")) == 3  # the synthesis and two refinement searches, not a third
    assert "refinement cap" in json.dumps(client.calls[-1][1]["messages"][-1])
    assert of(events, "coverage")


# ---------- the routes, once wired ----------

def _wired() -> bool:
    from backend.app import api
    from backend.app.api import deps
    return hasattr(api, "research_team") and hasattr(deps, "research_team")


@pytest.mark.skipif(not _wired(), reason="route not wired yet")
def test_the_routes_stream_a_run_and_list_it(tmp_path: Path) -> None:
    from backend.app.api import deps
    from backend.app.main import create_app
    from backend.app.settings import Settings

    client = ScriptedClient(conflict_script())
    settings = Settings(port=8000, budget_usd=5.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    app = create_app(settings, client=client)
    service = make(tmp_path, client)
    app.dependency_overrides[deps.research_team] = lambda: service
    api = TestClient(app, base_url="http://localhost:8000")
    info = api.get("/api/research-team/info", headers=LAB).json()
    assert len(info["sources"]) == 14 and [a["name"] for a in info["agents"]] == list(AGENTS)
    r = api.post("/api/research-team/run", headers=LAB, json={"question": "How many installs in 2024?", "model": HAIKU})
    lines = [json.loads(x) for x in r.text.splitlines() if x.strip()]
    assert lines[-1]["type"] == "done" and lines[-1]["status"] == "done"
    assert api.get("/api/research-team/runs", headers=LAB).json()["runs"][0]["unfinished"] == 0
    assert api.post("/api/research-team/run", json={"question": "x y z"}).status_code in (400, 403)
    assert api.post("/api/research-team/resume", headers=LAB, json={"run_id": "zz"}).status_code == 400


# ---------- found by code review: resuming safely ----------

def crashed_run(tmp_path: Path, model: str) -> str:
    """A run that crashed after its first search, started on `model`."""
    first = ScriptedClient([
        [use("set_subquestions", SQ)],
        [use("delegate", {"agent": "search", "task": "Find 2024 installation counts"})],
        [use("search_corpus", {"query": "installations 2024"})],
        [use("fetch_source", {"source_id": "S01"})],
        [use("submit_findings", {"findings": [{"claim": "98,000 installed in 2024", "evidence": EVIDENCE_1,
                                               "source_id": "S01", "sub_question": "q1"}], "summary": "one"})],
        [use("delegate", {"agent": "synthesis", "task": "Combine", "include_results": ["a1"]})],
    ])
    events = events_of(make(tmp_path, first), "How many installs?", model, 1.0, stop_after=1)
    return events[-1]["run_id"]


def test_a_run_that_is_still_going_cannot_be_resumed_and_its_manifest_is_left_alone(tmp_path: Path) -> None:
    run_id = crashed_run(tmp_path, HAIKU)
    service = make(tmp_path, ScriptedClient([]))
    manifest = tmp_path / "research-team" / run_id / "manifest.json"
    before = manifest.read_text()
    service._active.add(run_id)  # as if another request were resuming it right now
    with pytest.raises(ApiError) as caught:
        service.run("", HAIKU, 1.0, resume_id=run_id)
    assert caught.value.status == 409 and manifest.read_text() == before


def test_a_resumed_run_keeps_the_model_it_started_with(tmp_path: Path) -> None:
    run_id = crashed_run(tmp_path, "claude-sonnet-5-5")
    second = ScriptedClient([
        [use("submit_synthesis", {"claims": [{"sub_question_id": "q1", "claim": "98,000 in 2024",
                                              "source_ids": ["S01"], "status": "single_source"}]})],
        [use("finish", {"answer": "Done."})],
    ])
    service = make(tmp_path, second)
    events = events_of(service, "", None, 1.0, resume_id=run_id)
    assert events[-1]["status"] == "done" and events[-1]["model"] == "claude-sonnet-5-5"
    assert {c[1]["model"] for c in second.calls} == {"claude-sonnet-5-5"}
    assert run_id not in service._active  # free to resume again later
