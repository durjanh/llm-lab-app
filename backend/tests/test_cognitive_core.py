"""The cognitive core page: the questions and their checks, the library search, the tools, the six setups run side by
side, their stops and failures, and the small model's gateway. Fake models only: no local server, no key, no cost."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.api import deps
from backend.app.core.errors import ApiError
from backend.app.gateways.claude import ClaudeGateway
from backend.app.gateways.core_model import CoreModel, CoreModelUnavailable
from backend.app.main import create_app
from backend.app.services import cognitive_core as C
from backend.app.services.runs import Run, RunRegistry, RunStreamer
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_assistant import HAIKU, LAB, Fake, reply, text, use
from settings import EnvSettings


def last_text(params: dict) -> str:
    content = params["messages"][0]["content"]
    return content if isinstance(content, str) else ""


def answerer(model: str) -> Any:
    """A model that behaves as the experiment found: from memory it invents; given entries it reads them; with tools
    it searches once and answers from what came back (the big one), or never searches (the small one)."""
    def respond(params: dict) -> Any:
        system, messages = params["system"], params["messages"]
        question = last_text(params)
        if system == C.CLOSED:
            return reply(text("It opened in 1999."), model=model)
        if system == C.GIVEN:
            found = "1912" if "1912" in question else "I do not know."
            return reply(text(f"It opened in {found}."), model=model)
        if model == "small":  # with tools: answers from memory, never searching
            return reply(text("It opened in 1992."), model=model)
        if len(messages) == 1:
            return reply(use("search_library", {"query": "Tollan Bridge"}, 1), model=model)
        results = json.loads(messages[-1]["content"][0]["content"])["results"]
        return reply(text(f"It opened in {'1912' if 'Tollan' in results[0]['title'] else 'no idea'}."), model=model)
    return respond


class FakeCore:
    def __init__(self, respond: Any, model: str = "small"):
        self.model, self.respond, self.requests = model, respond, []
        self._lock = threading.Lock()

    def create(self, **params: Any) -> Any:
        with self._lock:
            self.requests.append(params)
        return self.respond(params)


def make(tmp_path: Path, core: FakeCore | None = None, big: Any = None, spend: SpendTracker | None = None,
         streamer: bool = True) -> tuple[TestClient, C.CognitiveCoreService, Fake]:
    settings = Settings(port=8000, budget_usd=5.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    fake = Fake(big or answerer(HAIKU))
    app = create_app(settings, client=fake)
    service = C.CognitiveCoreService(ClaudeGateway(fake), spend or SpendTracker(5.0), core or FakeCore(answerer("small")),
                                     RunStreamer(RunRegistry(), 5.0) if streamer else None, parallel=False)
    app.dependency_overrides[deps.cognitive_core] = lambda: service
    return TestClient(app, base_url="http://localhost:8000"), service, fake


def run(client: TestClient, questions: list[str], setups: list[str] = C.SETUPS, **extra: Any) -> list[dict]:
    r = client.post("/api/cognitive-core/run", headers=LAB,
                    json={"questions": questions, "setups": setups, "model": HAIKU, **extra})
    assert r.status_code == 200, r.text
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


def answer(events: list[dict], question: str, setup: str) -> dict:
    return next(e for e in events if e["type"] == "answer" and e["question"] == question and e["setup"] == setup)


# ----- the questions, the search and the tools -----
def test_each_question_accepts_its_answer_and_refuses_a_wrong_one():
    wrong = {"bridge-year": "1913", "lighthouse-designer": "Robert Stevenson", "kestle-population": "1,700",
             "tungsten": "W", "westphalia": "1919", "ethanol": "17.5", "years-between": "1931 and 1912, 21 years",
             "ferry-crossings": "12", "lighthouse-feet": "141", "ages": "Ana, Ben, Cara, Dev, so it is Ben."}
    for q in C.QUESTIONS:
        assert q["check"](q["expected"]), q["id"]
        assert not q["check"](wrong[q["id"]]), q["id"]
    assert C.QUESTIONS_BY_ID["ages"]["check"]("The second youngest is Cara.")
    assert not C.QUESTIONS_BY_ID["ages"]["check"]("I do not know.")
    assert C.numbers_in("-3, 4,860 and 78.37") == [-3.0, 4860.0, 78.37]


def test_search_finds_the_entry_first_and_is_the_same_every_time():
    assert C.search("Tollan Bridge opened")[0]["title"] == "Tollan Bridge"
    assert C.search("who designed Gull Point lighthouse")[0]["title"] == "Gull Point lighthouse"
    assert C.search("the of and") == []  # only words every search skips
    assert C.search("Kestle population") == C.search("Kestle population")


def test_the_tools_answer_and_say_what_went_wrong():
    assert C.run_tool("search_library", {"query": "tungsten"})["results"][0]["title"] == "Tungsten"
    assert C.run_tool("search_library", {"query": "zebra"}) == {"results": [], "note": "Nothing matched. Try other "
                                                                                       "words."}
    assert C.run_tool("calculator", {"expression": "(4860 + 1140) / 240"}) == {"result": 25.0}
    assert "Could not calculate" in C.run_tool("calculator", {"expression": "import os"})["error"]
    assert "Could not calculate" in C.run_tool("calculator", {"expression": "1/0"})["error"]
    assert C.run_tool("teleport", {}) == {"error": "There is no tool called teleport."}


# ----- the run -----
def test_six_setups_answer_side_by_side_and_code_marks_each(tmp_path):
    client, service, fake = make(tmp_path)
    events = run(client, ["bridge-year"])
    assert events[0]["type"] == "run" and events[1]["type"] == "started"
    marks = {s: answer(events, "bridge-year", s)["correct"] for s in C.SETUPS}
    assert marks == {"core_closed": False, "core_rag": True, "core_tools": False, "big_closed": False,
                     "big_rag": True, "big_tools": True}
    retrieved = [e for e in events if e["type"] == "step" and e["kind"] == "retrieved"]
    assert {e["setup"] for e in retrieved} == {"core_rag", "big_rag"} and "Tollan Bridge" in retrieved[0]["titles"]
    tools = answer(events, "bridge-year", "big_tools")
    assert tools["tool_calls"] == 1 and tools["model_calls"] == 2
    assert any(e["kind"] == "observation" and e["setup"] == "big_tools" for e in events if e["type"] == "step")
    # The small model ran on its gateway at no charge; the big one through the lab's client, charged.
    assert answer(events, "bridge-year", "core_tools")["cost_usd"] == 0 and tools["cost_usd"] > 0
    assert all(p["system"] in (C.CLOSED, C.GIVEN, C.WITH_TOOLS) for p in service.core.requests)
    assert {r["model"] for r in fake.requests} == {HAIKU}
    rag = next(r for r in fake.requests if r["system"] == C.GIVEN)
    assert rag["tools"] == C.CALCULATOR and "Library entries:" in rag["messages"][0]["content"]
    done = events[-1]
    assert done["type"] == "done" and done["spent_usd"] > 0
    summary = {s["setup"]: s for s in done["summary"]}
    assert summary["big_tools"]["correct"] == 1 and summary["core_closed"]["correct"] == 0


def test_a_cached_prompt_still_counts_as_tokens_in(tmp_path):
    def cached(params: dict) -> Any:
        r = reply(text("1912"), model="small", tokens=(5, 2))
        r.usage.cache_read_input_tokens = 400
        return r
    client, _, _ = make(tmp_path, core=FakeCore(cached))
    a = answer(run(client, ["bridge-year"], ["core_closed"]), "bridge-year", "core_closed")
    assert a["input_tokens"] == 405 and a["correct"]


def test_each_setup_stops_at_its_step_cap_its_budget_or_when_the_page_goes(tmp_path):
    forever = FakeCore(lambda p: reply(use("search_library", {"query": "bridge"}), model="small"))
    client, service, _ = make(tmp_path, core=forever)
    a = answer(run(client, ["bridge-year"], ["core_tools"]), "bridge-year", "core_tools")
    assert a["stopped"] == f"Stopped at the step cap ({C.MAX_STEPS} model calls)." and not a["correct"]
    assert a["model_calls"] == C.MAX_STEPS and a["tool_calls"] == C.MAX_STEPS

    budget = C.Budget(0.01)
    budget.settle(0.0, 0.02)
    attempt = C.Attempt(service, "big_closed", C.QUESTIONS[0], HAIKU, Run(), budget)
    with pytest.raises(C.Stop, match="budget"):
        attempt.answer()
    gone = Run()
    gone.cancelled.set()
    with pytest.raises(C.Stop, match="went away"):
        C.Attempt(service, "core_closed", C.QUESTIONS[0], HAIKU, gone, C.Budget(1)).answer()


def test_one_setup_failing_leaves_the_others_and_says_why(tmp_path):
    def broken(params: dict) -> Any:
        raise ApiError(503, "down", "The core model is not answering.")
    client, _, _ = make(tmp_path, core=FakeCore(broken))
    events = run(client, ["bridge-year"], ["core_closed", "big_rag"])
    assert answer(events, "bridge-year", "core_closed")["stopped"] == "The core model is not answering."
    assert answer(events, "bridge-year", "big_rag")["correct"]

    def crash(params: dict) -> Any:
        raise RuntimeError("socket closed")
    client, _, _ = make(tmp_path, core=FakeCore(crash))
    stopped = answer(run(client, ["bridge-year"], ["core_closed"]), "bridge-year", "core_closed")["stopped"]
    assert "socket closed" in stopped


def test_setups_run_side_by_side_and_the_run_ends_when_the_page_goes(tmp_path):
    client, service, _ = make(tmp_path)
    service.parallel = True
    events = run(client, ["bridge-year", "tungsten"], ["core_rag", "big_rag"])
    assert len([e for e in events if e["type"] == "answer"]) == 4


def test_no_question_starts_once_the_page_has_gone(tmp_path, monkeypatch):
    _, service, _ = make(tmp_path)
    gone, published = Run(), []
    gone.cancelled.set()
    monkeypatch.setattr(gone, "publish", published.append)
    monkeypatch.setattr(C, "Run", lambda: gone)
    service.streamer = type("Now", (), {"lines": staticmethod(lambda run, work: work() or iter(()))})()
    list(service.run(["bridge-year", "tungsten"], ["core_closed"], HAIKU, 0.1))
    assert [e["type"] for e in published] == ["started", "done"] and not service.core.requests


def test_requests_that_cannot_run_are_refused(tmp_path):
    client, service, _ = make(tmp_path)
    assert client.post("/api/cognitive-core/run", headers=LAB, json={"questions": ["nope"], "setups": ["core_rag"],
                                                                    "model": HAIKU}).status_code == 400
    assert client.post("/api/cognitive-core/run", headers=LAB, json={"questions": ["tungsten"], "setups": ["x"],
                                                                    "model": HAIKU}).status_code == 400
    service.core = FakeCore(answerer("small"), model="")
    r = client.post("/api/cognitive-core/run", headers=LAB, json={"questions": ["tungsten"], "setups": ["core_rag"]})
    assert r.status_code == 409 and "local-model.sh --core" in r.json()["error"]["message"]
    assert run(client, ["tungsten"], ["big_closed"])[-1]["type"] == "done"  # the big model alone still runs
    _, without, _ = make(tmp_path, streamer=False)
    with pytest.raises(ApiError) as err:
        without.run(["tungsten"], ["big_closed"], HAIKU, 0.1)
    assert err.value.status == 503


def test_the_info_route_lists_the_questions_library_and_prompts(tmp_path):
    client, _, _ = make(tmp_path)
    info = client.get("/api/cognitive-core/info", headers=LAB).json()
    assert info["core_model"] == "small" and [s["id"] for s in info["setups"]] == C.SETUPS
    assert len(info["questions"]) == len(C.QUESTIONS) and "check" not in info["questions"][0]
    assert info["prompts"] == {"closed": C.CLOSED, "rag": C.GIVEN, "tools": C.WITH_TOOLS}


def test_the_app_builds_the_service_with_the_core_model_from_settings(tmp_path):
    settings = Settings(port=8000, budget_usd=5.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models", core_model="ai/tiny")
    app = create_app(settings, client=Fake([]))
    assert app.state.container.cognitive_core.core.model == "ai/tiny"
    info = TestClient(app, base_url="http://localhost:8000").get("/api/cognitive-core/info", headers=LAB).json()
    assert info["core_model"] == "ai/tiny"  # through the real dependency, not a test's override
    assert EnvSettings.from_env({"LLM_LAB_CORE_MODEL": " ai/other "}).core_model == "ai/other"
    assert EnvSettings.from_env({"LLM_LAB_CORE_MODEL": ""}).core_model == ""  # empty switches it off
    assert EnvSettings.from_env({}).core_model == "ai/qwen3.5:0.8b-q4_K_XL"


# ----- the small model's gateway -----
def test_the_core_gateway_names_its_model_and_says_what_to_run_when_it_is_down(monkeypatch):
    with pytest.raises(CoreModelUnavailable, match="LLM_LAB_CORE_MODEL"):
        CoreModel("", "http://localhost:1").create(max_tokens=5, messages=[])
    core = CoreModel("ai/tiny", "http://localhost:1")
    seen: list[dict] = []
    monkeypatch.setattr(core._local, "create", lambda params: seen.append(params) or "reply")
    assert core.create(model="ignored", max_tokens=5, messages=[]) == "reply" and seen[0]["model"] == "ai/tiny"

    class ModelUnavailable(RuntimeError):
        pass

    def down(params: dict) -> Any:
        raise ModelUnavailable("not answering")
    monkeypatch.setattr(core._local, "create", down)
    with pytest.raises(CoreModelUnavailable, match="local-model.sh --core"):
        core.create(max_tokens=5, messages=[])

    def refused(params: dict) -> Any:
        raise ValueError("bad request")
    monkeypatch.setattr(core._local, "create", refused)
    with pytest.raises(ValueError, match="bad request"):
        core.create(max_tokens=5, messages=[])


# ----- review findings, each recreated -----
def test_the_puzzle_is_marked_by_the_name_given_as_second_youngest():
    check = C.QUESTIONS_BY_ID["ages"]["check"]
    assert check("Cara is the second youngest, older than Dev.")  # was marked wrong: Dev came last
    assert check("Dev is the youngest, Cara is the second youngest, Ben the third.")
    assert check("The second youngest is Cara.") and check("Cara")
    assert not check("Ben is the second youngest.") and not check("Ana, Ben, Cara, Dev, so it is Ben.")
    assert C.numbers_in("opened in 1912,1931 was the light") == [1912.0, 1931.0]  # two years, not one number


def test_setups_calling_at_once_cannot_spend_past_the_cap_together(tmp_path):
    """Each paid call reserves its worst case first: three calls starting together cannot all see the same room."""
    budget = C.Budget(C.worst_cost(HAIKU) * 2.5)
    assert budget.reserve(C.worst_cost(HAIKU)) and budget.reserve(C.worst_cost(HAIKU))
    assert not budget.reserve(C.worst_cost(HAIKU))  # a third would pass the cap
    budget.settle(C.worst_cost(HAIKU), 0.0001)  # the first came in far under its worst case
    assert budget.reserve(C.worst_cost(HAIKU))
    assert C.worst_cost("ai/on-this-machine") == 0.0 and budget.reserve(0.0)
    opus = "claude-opus-5-5"
    client, _, _ = make(tmp_path, big=answerer(opus))  # replies priced as Opus: $0.011 each, up to $0.028
    events = run(client, ["bridge-year"], ["big_closed", "big_rag", "big_tools"], budget_usd=0.05, model=opus)
    stopped = [e for e in events if e["type"] == "answer" and e["stopped"]]
    assert stopped and all("could pass the run's budget" in e["stopped"] for e in stopped)
    assert events[-1]["spent_usd"] <= 0.05  # never past the cap, though each call could cost $0.028


def test_a_second_run_is_refused_while_one_is_going_and_the_lock_is_freed_after(tmp_path):
    client, service, _ = make(tmp_path)
    assert service._busy.acquire(blocking=False)  # a run is going
    r = client.post("/api/cognitive-core/run", headers=LAB, json={"questions": ["tungsten"], "setups": ["core_rag"]})
    assert r.status_code == 409 and r.json()["error"]["type"] == "busy"
    service._busy.release()
    run(client, ["tungsten"], ["core_rag"])
    assert service._busy.acquire(blocking=False)  # the finished run let it go
    service._busy.release()
    # The page goes before the work begins: the stream is closed unstarted (its own `finally` never runs), or started
    # and closed before the worker runs. Either way the lock is let go, once.
    service.start_within_s = 0.05
    service.run(["tungsten"], ["core_rag"], HAIKU, 0.1).close()
    deadline = time.time() + 2
    while not service._busy.acquire(blocking=False):
        assert time.time() < deadline, "the run lock was never let go"
        time.sleep(0.01)
    service._busy.release()
    service.start_within_s = 30.0
    slow = type("Slow", (), {"lines": staticmethod(lambda run, work: iter(["first line"]))})()
    service.streamer = slow  # yields without ever starting the work
    assert list(service.run(["tungsten"], ["core_rag"], HAIKU, 0.1)) == ["first line"]
    assert service._busy.acquire(blocking=False)  # freed when the stream ended
    service._busy.release()


def test_an_empty_refused_or_cut_off_reply_says_so_instead_of_a_blank_wrong_answer(tmp_path):
    for message, expected in ((reply(text(""), model="small"), "gave no answer"),
                              (reply(text("I can't help"), stop="refusal", model="small"), "refused"),
                              (reply(text("Thinking"), stop="max_tokens", model="small"), "token limit")):
        client, _, _ = make(tmp_path, core=FakeCore(lambda p, m=message: m))
        a = answer(run(client, ["bridge-year"], ["core_closed"]), "bridge-year", "core_closed")
        assert expected in a["stopped"] and not a["correct"] and a["answer"] == ""


@pytest.mark.filterwarnings("ignore:Pydantic serializer warnings")  # the malformed input is the point
def test_a_tool_call_whose_input_is_not_an_object_gets_an_error_it_can_correct(tmp_path):
    calls: list[dict] = []

    def odd(params: dict) -> Any:
        calls.append(params)
        if len(calls) == 1:
            r = reply(use("search_library", {"query": "x"}), model="small")
            r.content[0].input = "Tollan Bridge"  # a small model's malformed call
            return r
        return reply(text("1912"), model="small")
    client, _, _ = make(tmp_path, core=FakeCore(odd))
    events = run(client, ["bridge-year"], ["core_tools"])
    observed = next(e for e in events if e["type"] == "step" and e["kind"] == "observation")
    assert "must be an object" in observed["result"]["error"]
    assert answer(events, "bridge-year", "core_tools")["correct"]


def test_the_core_model_being_down_reads_as_one_clean_sentence(tmp_path):
    def down(params: dict) -> Any:
        raise CoreModelUnavailable("The core model ai/tiny is not answering. Start Docker Desktop.")
    client, _, _ = make(tmp_path, core=FakeCore(down))
    stopped = answer(run(client, ["bridge-year"], ["core_closed"]), "bridge-year", "core_closed")["stopped"]
    assert stopped == "The core model ai/tiny is not answering. Start Docker Desktop."


def test_work_that_starts_after_the_lock_was_let_go_does_nothing(tmp_path):
    """The timer gave the lock up because the work had not started; when the work starts late, it must not run, or a
    second run could be going at the same time, and must not let the lock go a second time."""
    _, service, _ = make(tmp_path)
    service.start_within_s = 0.01

    def late(run: Any, work: Any) -> Any:
        time.sleep(0.2)  # the timer has fired by now
        work()
        yield "after"
    service.streamer = type("Late", (), {"lines": staticmethod(late)})()
    assert list(service.run(["tungsten"], ["core_rag"], HAIKU, 0.1)) == ["after"]
    assert service.core.requests == []  # the late work did not run
    assert service._busy.acquire(blocking=False)  # free, and released once: acquiring works, and is held now
    assert not service._busy.acquire(blocking=False)
    service._busy.release()
