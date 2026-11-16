"""Model failover: the router's rules, the stores, the agent that switches model part way through a turn, compaction and the
routes, with a fake client that answers from a script. No network, no key, no cost. BlobTableStore also runs against Azurite
when it is listening on this machine (127.0.0.1:10000 and 10002), and is skipped otherwise."""
from __future__ import annotations

import json
import socket
import threading
from pathlib import Path
from typing import Any

import anthropic
import httpx
import pytest
from anthropic.types import Message
from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.gateways.claude import ClaudeGateway
from backend.app.main import create_app
from backend.app.services import model_failover as mf
from backend.app.services.conversation_store import (BlobTableStore, Conflict, FileStore, MemoryStore, NotFound, SqlStore,
                                                     Step, azurite_connection_string, blob_path, blob_table_store,
                                                     store_from_settings)
from backend.app.services.model_failover import Compaction, ModelFailoverService, TicketDesk
from backend.app.services.model_router import (AllPoolsFailed, ModelRouter, Pool, Verdict, classify)
from backend.app.services.runs import RunRegistry, RunStreamer
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_api import LAB

SONNET, HAIKU, GPT = "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-5.4-mini"


def default_pools(gpt_models: list[str] | None = None) -> list[Pool]:
    """The pools of config/model-failover.json, written out, for tests that build a router directly."""
    pools = [Pool(SONNET, SONNET, "anthropic", 200_000, "primary"), Pool(HAIKU, HAIKU, "anthropic", 200_000, "same family, cheaper")]
    return pools + [Pool(g, g, "azure-openai", 128_000, "other provider") for g in (gpt_models or [])[:1]]


# ----- a fake client that answers from a script, per model -----

def text(t: str) -> dict:
    return {"type": "text", "text": t}


def use(name: str, args: dict, i: int = 1) -> dict:
    return {"type": "tool_use", "id": f"toolu_{name}_{i}", "name": name, "input": args}


def status_error(code: int, retry_after: str | None = None) -> anthropic.APIStatusError:
    headers = {"retry-after": retry_after} if retry_after else {}
    response = httpx.Response(code, headers=headers, request=httpx.Request("POST", "http://test/v1/messages"))
    return anthropic.APIStatusError(f"error {code}", response=response, body=None)


def message(model: str, blocks: list[dict], stop: str | None = None, tokens: tuple[int, int] = (1000, 100)) -> Message:
    stop = stop or ("tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn")
    return Message.model_validate({"id": "msg_test", "type": "message", "role": "assistant", "model": model, "content": blocks,
                                   "stop_reason": stop, "stop_sequence": None,
                                   "usage": {"input_tokens": tokens[0], "output_tokens": tokens[1]}})


class FakeMessages:
    def __init__(self, owner: "Fake"):
        self.owner = owner

    def create(self, **params: Any) -> Message:
        params = {k: v for k, v in params.items() if k not in ("betas", "fallbacks")}
        self.owner.calls.append(params)
        entry = self.owner.script[params["model"]].pop(0)
        if callable(entry):
            entry = entry()
        if isinstance(entry, BaseException):
            raise entry
        blocks, stop = entry if isinstance(entry, tuple) else (entry, None)
        return message(params["model"], blocks, stop)


class Fake:
    """Each model has its own queue of replies: a list of blocks, (blocks, stop_reason), an exception, or a function."""

    def __init__(self, script: dict[str, list[Any]]):
        self.script = {SONNET: [], HAIKU: [], GPT: [], **script}
        self.calls: list[dict] = []
        self.messages = FakeMessages(self)
        self.beta = type("Beta", (), {"messages": self.messages})()
        self.models = type("Models", (), {"retrieve": lambda _s, m: {"id": m}})()

    def models_called(self) -> list[str]:
        return [c["model"] for c in self.calls]


def make(script: dict[str, list[Any]], store: Any = None, pools: list[Pool] | None = None, cfg: Compaction | None = None,
         clock: Any = None) -> tuple[ModelFailoverService, Fake]:
    fake = Fake(script)
    router = ModelRouter(pools or default_pools(), cooldown_s=30, sleep=lambda s: None, **({"clock": clock} if clock else {}))
    svc = ModelFailoverService(ClaudeGateway(fake), SpendTracker(5.0), RunStreamer(RunRegistry(), 1.0),
                               store or MemoryStore(), router, cfg or Compaction(), TicketDesk())
    return svc, fake


def events(lines: Any) -> list[dict]:
    return [json.loads(line) for line in lines if line.strip()]


def talk(svc: ModelFailoverService, conv_id: str, message_text: str, primary: str | None = SONNET) -> list[dict]:
    return events(svc.send(conv_id, message_text, primary))


def kinds(evs: list[dict], kind: str) -> list[dict]:
    return [e for e in evs if e["type"] == kind]


def new_conv(svc: ModelFailoverService) -> str:
    return svc.create_conversation()["id"]


def steps_of(svc: ModelFailoverService, conv_id: str) -> list[Step]:
    return svc.store.load(conv_id).steps


# ----- the router -----

def test_classify_is_the_error_table() -> None:
    assert classify(status_error(429, "1")).action == "retry"
    assert classify(status_error(429, "2")).action == "retry"
    assert classify(status_error(429, "30")).action == "switch"
    assert classify(status_error(429)).action == "switch"
    for code in (529, 500, 502, 503, 504, 408):
        assert classify(status_error(code)).action == "switch"
    for code in (400, 401, 403, 404, 413, 422):
        assert classify(status_error(code)).action == "fail"
    assert classify(TimeoutError()).action == "switch"
    assert classify(anthropic.APITimeoutError(httpx.Request("POST", "http://x"))).action == "switch"
    assert classify(ValueError("a bug")).action == "fail"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def two_pools(clock: Clock | None = None) -> ModelRouter:
    pools = [Pool("a", "a", "anthropic"), Pool("b", "b", "anthropic")]
    return ModelRouter(pools, cooldown_s=30, clock=clock or Clock(), sleep=lambda s: None)


def test_the_breaker_opens_skips_the_pool_and_half_opens_after_the_cooldown() -> None:
    clock = Clock()
    router = two_pools(clock)
    seen: list[str] = []

    def send(pool: Pool) -> str:
        seen.append(pool.name)
        if pool.name == "a" and fail_a:
            raise status_error(529)
        return pool.name

    fail_a = True
    first = router.call(send)
    assert first.result == "b" and first.fallback_from == "a" and first.reason == "529"
    assert [e["type"] for e in first.events] == ["switch"] and first.events[0]["to"] == "b"
    assert router.status()["pools"][0]["state"] == "open"
    seen.clear()
    second = router.call(send)  # a's breaker is open: it is not even tried
    assert seen == ["b"] and second.fallback_from == "a" and "breaker open" in second.reason
    assert second.events[0]["type"] == "switch" and "breaker open" in second.events[0]["reason"]
    clock.now += 31
    assert router.status()["pools"][0]["state"] == "half-open"
    fail_a = False
    seen.clear()
    third = router.call(send)  # the probe
    assert seen == ["a"] and third.result == "a" and third.fallback_from == ""
    assert router.status()["pools"][0]["state"] == "closed"


def test_a_failed_probe_opens_the_breaker_again_and_only_one_probe_runs_at_a_time() -> None:
    clock = Clock()
    router = two_pools(clock)
    router.inject("a", "529", 2)
    assert router.call(lambda p: p.name).result == "b"
    clock.now += 31
    assert router.call(lambda p: p.name).result == "b"  # the probe took the second injected fault
    assert router.status()["pools"][0]["state"] == "open"
    clock.now += 31
    release, probing = threading.Event(), threading.Event()

    def slow(pool: Pool) -> str:
        if pool.name == "a":
            probing.set()
            release.wait(5)
        return pool.name

    thread = threading.Thread(target=lambda: router.call(slow))
    thread.start()
    assert probing.wait(5)
    assert router.call(lambda p: p.name).result == "b"  # a is half-open with a probe in flight: skipped
    release.set()
    thread.join()
    assert router.status()["pools"][0]["state"] == "closed"


def test_a_short_retry_after_retries_the_same_pool_once() -> None:
    router = two_pools()
    calls: list[str] = []

    def send(pool: Pool) -> str:
        calls.append(pool.name)
        if len(calls) == 1:
            raise status_error(429, "1")
        return "ok"

    routed = router.call(send)
    assert calls == ["a", "a"] and routed.pool.name == "a" and routed.fallback_from == ""
    assert [e["type"] for e in routed.events] == ["retry"]
    router.inject("a", "429_short", 2)  # two short ones in a row: one retry, then it switches
    assert router.call(lambda p: p.name).result == "b"


def test_a_failure_no_other_pool_could_fix_is_raised_without_switching() -> None:
    router = two_pools()
    calls: list[str] = []

    def send(pool: Pool) -> str:
        calls.append(pool.name)
        raise status_error(400)

    with pytest.raises(anthropic.APIStatusError):
        router.call(send)
    assert calls == ["a"] and router.status()["pools"][0]["state"] == "closed"


def test_when_every_pool_fails_the_error_lists_each() -> None:
    router = two_pools()
    router.inject("a", "429")
    router.inject("b", "timeout")
    with pytest.raises(AllPoolsFailed) as caught:
        router.call(lambda p: p.name)
    assert caught.value.status == 503 and "a:" in caught.value.message and "timeout" in caught.value.message


def test_injected_faults_cost_nothing_and_are_used_once_each_under_concurrency() -> None:
    router = two_pools()
    router.inject("a", "529", 5)
    sent: list[str] = []
    results: list[str] = []
    lock = threading.Lock()

    def send(pool: Pool) -> str:
        with lock:
            sent.append(pool.name)
        return pool.name

    def worker() -> None:
        try:
            r = router.call(send).result
        except AllPoolsFailed:
            r = "none"
        with lock:
            results.append(r)

    threads = [threading.Thread(target=worker) for _ in range(20)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    status = router.status()["pools"]
    used = 5 - len(status[0]["faults"])  # each injected fault was taken by exactly one call, never twice
    assert used >= 1 and status[0]["failures"] == used
    assert len(results) == 20 and "none" not in results
    assert status[0]["successes"] + status[1]["successes"] == 20
    assert len(sent) == 20  # a fault sends nothing: one real send per request


# ----- the stores -----

def azurite_up() -> bool:
    for port in (10000, 10002):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        except OSError:
            return False
    return True


@pytest.fixture(params=["memory", "files", "azurite"])
def store(request: Any, tmp_path: Path) -> Any:
    if request.param == "memory":
        return MemoryStore()
    if request.param == "files":
        return FileStore(tmp_path / "mf")
    if not azurite_up():
        pytest.skip("Azurite is not running on 127.0.0.1:10000 and 10002")
    return blob_table_store(connection_string="UseDevelopmentStorage=true")


def user_step(turn: int, step: int = 0, words: str = "hello") -> Step:
    return Step(turn, step, "user", "user", [{"type": "text", "text": words}])


def test_a_store_keeps_steps_in_order_with_an_etag_fence(store: Any) -> None:
    conv = store.create("lab")
    etag = store.append_step(conv.id, user_step(0, 0, "How much leave do I get?"), conv.etag, "lab")
    etag2 = store.append_step(conv.id, Step(0, 1, "model", "assistant", [text("25 days")], SONNET, "anthropic",
                                            input_tokens=10, output_tokens=3), etag, "lab")
    loaded = store.load(conv.id)
    assert [s.key for s in loaded.steps] == ["000000-00", "000000-01"] and loaded.etag == etag2
    assert loaded.title == "How much leave do I get?" and loaded.status == "running" and loaded.last_step == "000000-01"
    assert loaded.steps[1].model == SONNET and loaded.steps[1].blob_path == blob_path("lab", conv.id, "000000-01")
    with pytest.raises(Conflict):  # a writer holding the old ETag
        store.append_step(conv.id, user_step(1), etag, "lab")
    assert len(store.load(conv.id).steps) == 2  # and nothing was written
    rows = store.rows(conv.id, "lab")
    assert rows["blobs"] == [f"conversations/lab/{conv.id}/steps/000000-00.json", f"conversations/lab/{conv.id}/steps/000000-01.json"]
    assert rows["step_rows"][1]["model"] == SONNET and rows["conversation_row"]["lastStep"] == "000000-01"
    assert conv.id in [c.id for c in store.list("lab")]
    store.update_meta(conv.id, loaded.etag, status="idle", overrides={"keep_recent": 2}, user_id="lab")
    assert store.load(conv.id).overrides == {"keep_recent": 2}
    store.delete(conv.id, "lab")
    with pytest.raises(NotFound):
        store.load(conv.id)
    assert conv.id not in [c.id for c in store.list("lab")]


def test_a_torn_write_is_repaired_on_load_so_a_run_resumes_from_the_last_whole_step(store: Any) -> None:
    conv = store.create("lab")
    etag = store.append_step(conv.id, user_step(0), conv.etag, "lab")
    row, current = store._conv_get("lab", conv.id)
    store._conv_replace({**row, "lastStep": "000000-01"}, current)  # claimed a step, then crashed before writing it
    loaded = store.load(conv.id)
    assert loaded.last_step == "000000-00" and len(loaded.steps) == 1
    store.append_step(conv.id, Step(0, 1, "model", "assistant", [text("hi")]), loaded.etag, "lab")
    assert len(store.load(conv.id).steps) == 2
    store.delete(conv.id, "lab")


def test_the_store_choice_follows_the_settings_and_refuses_real_keys(tmp_path: Path) -> None:
    assert isinstance(store_from_settings(Settings(generated_dir=tmp_path)), FileStore)
    assert azurite_connection_string("UseDevelopmentStorage=true")
    with pytest.raises(ValueError):
        azurite_connection_string("DefaultEndpointsProtocol=https;AccountName=prod;AccountKey=abc;EndpointSuffix=core.windows.net")
    with pytest.raises(NotImplementedError):
        SqlStore().load("abc")


def test_a_concurrent_append_has_one_winner() -> None:
    store = MemoryStore()
    conv = store.create("lab")
    outcomes: list[str] = []

    def write(n: int) -> None:
        try:
            store.append_step(conv.id, user_step(0, 0, f"writer {n}"), conv.etag, "lab")
            outcomes.append("won")
        except Conflict:
            outcomes.append("conflict")

    threads = [threading.Thread(target=write, args=(i,)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert outcomes.count("won") == 1 and outcomes.count("conflict") == 7 and len(store.load(conv.id).steps) == 1


# ----- the agent -----

def test_a_429_part_way_through_a_turn_switches_model_and_the_next_model_sees_the_tool_result() -> None:
    svc, fake = make({SONNET: [[use("search_handbook", {"query": "annual leave"})], status_error(429, "30")],
                      HAIKU: [[text("You get 25 days.")]]})
    conv = new_conv(svc)
    evs = talk(svc, conv, "How many days of annual leave do I get?")
    switch = kinds(evs, "switch")[0]
    assert (switch["from"], switch["to"], switch["retry_after"]) == (SONNET, HAIKU, 30.0) and "429" in switch["reason"]
    done = kinds(evs, "done")[0]
    assert done["reply"] == "You get 25 days." and done["model"] == HAIKU and done["switches"] == 1
    steps = steps_of(svc, conv)
    assert [(s.kind, s.model) for s in steps] == [("user", ""), ("model", SONNET), ("tool", ""), ("model", HAIKU)]
    assert steps[3].fallback_from == SONNET and "429" in steps[3].reason and steps[3].provider == "anthropic"
    seen = fake.calls[-1]["messages"]  # what haiku was sent: the whole history, including the tool result
    assert fake.calls[-1]["model"] == HAIKU and [m["role"] for m in seen] == ["user", "assistant", "user"]
    assert seen[1]["content"][0]["type"] == "tool_use"
    assert "25 days" in seen[2]["content"][0]["content"]
    assert svc.spend.calls == 2 and svc.router.status()["pools"][0]["state"] == "open"  # the failed call cost nothing


def test_a_switch_after_a_write_tool_does_not_repeat_it() -> None:
    svc, fake = make({SONNET: [[use("create_ticket", {"subject": "Confirm meal limit"})]], HAIKU: [[text("Raised NW-1001.")]]})
    conv = new_conv(svc)
    calls = {"n": 0}
    original = svc.router.call

    def call(send: Any, primary: Any = None, on_event: Any = None) -> Any:
        calls["n"] += 1
        if calls["n"] == 2:
            svc.router.inject(SONNET, "529")  # the second model call finds sonnet overloaded
        return original(send, primary, on_event)

    svc.router.call = call  # type: ignore[method-assign]
    evs = talk(svc, conv, "Please raise a ticket to confirm the meal limit.")
    assert kinds(evs, "done")[0]["model"] == HAIKU
    assert len(svc.desk.tickets) == 1
    assert fake.models_called() == [SONNET, HAIKU]
    result = fake.calls[-1]["messages"][-1]["content"][0]
    assert result["type"] == "tool_result" and json.loads(result["content"])["ticket"] == "NW-1001"


class CrashOnce(MemoryStore):
    """Fails the first write of a tool step, after the tool has run: a crash between doing the work and recording it."""

    def __init__(self) -> None:
        super().__init__()
        self.armed = True

    def append_step(self, conv_id: str, step: Step, expected_etag: str, user_id: str | None = None) -> str:
        if self.armed and step.kind == "tool":
            self.armed = False
            raise RuntimeError("the process died")
        return super().append_step(conv_id, step, expected_etag, user_id)


def test_a_crash_after_the_tool_ran_resumes_without_a_second_ticket() -> None:
    svc, fake = make({SONNET: [[use("create_ticket", {"subject": "Parental leave dates"})], [text("Done: NW-1001.")]]},
                     store=CrashOnce())
    conv = new_conv(svc)
    evs = talk(svc, conv, "Raise a ticket about parental leave dates.")
    assert kinds(evs, "error")[0]["can_resume"] and len(svc.desk.tickets) == 1
    assert svc.get_conversation(conv)["incomplete"] and svc.store.load(conv).status == "failed"
    resumed = events(svc.resume(conv, SONNET))
    assert kinds(resumed, "done")[0]["reply"] == "Done: NW-1001."
    assert len(svc.desk.tickets) == 1  # the same idempotency key: the desk returned the ticket it already had
    tool_step = steps_of(svc, conv)[2]
    assert tool_step.kind == "tool" and json.loads(tool_step.content[0]["content"])["already_existed"] is True


def test_an_api_error_after_a_tool_step_leaves_a_history_that_resumes_from_that_step() -> None:
    svc, fake = make({SONNET: [[use("search_handbook", {"query": "expenses"})], status_error(400), [text("£35 a day.")]]})
    conv = new_conv(svc)
    evs = talk(svc, conv, "Meal limit?")
    assert "error" in [e["type"] for e in evs] and fake.models_called() == [SONNET, SONNET]  # 400: no switch
    assert [s.kind for s in steps_of(svc, conv)] == ["user", "model", "tool"]
    assert svc.router.status()["pools"][0]["state"] == "closed"
    out = events(svc.resume(conv, SONNET))
    assert kinds(out, "done")[0]["reply"] == "£35 a day."
    assert [m["role"] for m in fake.calls[-1]["messages"]] == ["user", "assistant", "user"]
    with pytest.raises(ApiError) as caught:  # a finished turn has nothing to resume
        svc.resume(conv, SONNET)
    assert caught.value.status == 400


def test_a_new_message_after_a_failed_turn_finishes_the_tools_first() -> None:
    svc, fake = make({SONNET: [[use("search_handbook", {"query": "leave"})], status_error(400), [text("Leave is 25 days; sick pay 20.")]]})
    conv = new_conv(svc)
    talk(svc, conv, "Leave?")
    talk(svc, conv, "And sick pay?")
    sent = fake.calls[-1]["messages"]
    assert [m["role"] for m in sent] == ["user", "assistant", "user"]  # the tool result and the new question share a message
    assert [b["type"] for b in sent[2]["content"]] == ["tool_result", "text"]


def test_refusals_and_empty_replies_leave_a_history_the_next_turn_can_send() -> None:
    svc, fake = make({SONNET: [([], "refusal"), ([], "end_turn"), ([text("cut off")], "max_tokens"), [text("Fine.")]]})
    conv = new_conv(svc)
    first = kinds(talk(svc, conv, "Odd request"), "done")[0]
    assert first["stop_reason"] == "refusal" and "No reply" in first["reply"]
    second = kinds(talk(svc, conv, "Again"), "done")[0]
    assert second["stop_reason"] == "end_turn" and "No reply" in second["reply"]
    third = kinds(talk(svc, conv, "Third"), "done")[0]
    assert third["stop_reason"] == "max_tokens" and third["reply"] == "cut off"
    assert kinds(talk(svc, conv, "Last"), "done")[0]["reply"] == "Fine."
    for call in fake.calls:
        assert all(m["content"] for m in call["messages"])  # no empty assistant turn ever reached the API
    assert fake.models_called() == [SONNET] * 4  # a refusal does not switch


def test_thinking_blocks_are_kept_in_the_store_and_sent_only_to_the_model_that_wrote_them() -> None:
    from gpt_model import to_chat
    thinking = {"type": "thinking", "thinking": "hmm", "signature": "sig"}
    steps = [user_step(0), Step(0, 1, "model", "assistant", [thinking, text("answer")], SONNET, "anthropic")]
    steps.append(user_step(1, 0, "next"))
    claude_view = mf.build_messages(steps, Pool(SONNET, SONNET, "anthropic"))
    other_view = mf.build_messages(steps, Pool(GPT, GPT, "azure-openai"))
    assert claude_view[1]["content"][0]["type"] == "thinking"
    assert [b["type"] for b in other_view[1]["content"]] == ["text"]
    assert steps[1].content[0]["type"] == "thinking"  # the store still has it
    chat = to_chat({"messages": other_view})
    assert [m["role"] for m in chat] == ["user", "assistant", "user"] and chat[1]["content"] == "answer"


def test_gpt_gets_the_history_in_claudes_shape_and_its_replies_are_recorded_with_its_provider() -> None:
    pools = default_pools([GPT])
    svc, fake = make({SONNET: [[use("search_handbook", {"query": "travel"})]], GPT: [[text("Economy under six hours.")]]},
                     pools=pools)
    conv = new_conv(svc)
    talk(svc, conv, "Which flight class?")
    svc.router.inject(SONNET, "529", 1)
    svc.router.inject(HAIKU, "timeout", 1)
    out = events(svc.resume(conv, SONNET))
    last = steps_of(svc, conv)[-1]
    assert kinds(out, "done")[0]["model"] == GPT and last.provider == "azure-openai" and last.fallback_from == SONNET
    assert len(kinds(out, "switch")) == 2


def test_two_requests_for_one_conversation_get_busy_not_a_corrupted_history() -> None:
    gate = threading.Event()
    svc, fake = make({SONNET: [lambda: (gate.wait(5), [text("slow answer")])[1]]})
    conv = new_conv(svc)
    stream = svc.send(conv, "first", SONNET)  # claimed now
    with pytest.raises(ApiError) as caught:
        svc.send(conv, "second", SONNET)
    assert caught.value.status == 409 and caught.value.kind == "busy"
    gate.set()
    assert kinds(events(stream), "done")
    assert [s.kind for s in steps_of(svc, conv)] == ["user", "model"]


def test_a_stale_etag_from_another_process_is_a_409() -> None:
    svc, _ = make({SONNET: [[text("hi")]]})
    conv = new_conv(svc)
    loaded = svc.store.load(conv)
    svc.store.update_meta(conv, loaded.etag, title="changed elsewhere")  # a second backend wrote first
    t = mf._Turn(svc, conv, "lab", [], loaded.etag, Compaction(), None, None)
    with pytest.raises(Conflict):
        t.append(user_step(0))


# ----- compaction -----

def seed(svc: ModelFailoverService, conv_id: str, turns: int, words: int = 0, ticket_in: int | None = None) -> None:
    """History as if `turns` turns had been had: a question and an answer each, optionally with a ticket in one."""
    store = svc.store
    etag = store.load(conv_id).etag
    start = len({s.turn for s in store.load(conv_id).steps})
    for n in range(start, start + turns):
        padding = " lorem ipsum" * words
        rows = [Step(n, 0, "user", "user", [text(f"question {n}{padding}")])]
        if n == ticket_in:
            rows += [Step(n, 1, "model", "assistant", [use("create_ticket", {"subject": "Meal limit"}, n)], SONNET, "anthropic",
                          stop_reason="tool_use"),
                     Step(n, 2, "tool", "user", [{"type": "tool_result", "tool_use_id": f"toolu_create_ticket_{n}",
                                                  "content": json.dumps({"ticket": "NW-1001", "subject": "Meal limit",
                                                                         "status": "open", "already_existed": False}),
                                                  "is_error": False}], tool="create_ticket"),
                     Step(n, 3, "model", "assistant", [text(f"answer {n}")], SONNET, "anthropic", stop_reason="end_turn")]
        else:
            rows.append(Step(n, 1, "model", "assistant", [text(f"answer {n}")], SONNET, "anthropic", stop_reason="end_turn"))
        for row in rows:
            etag = store.append_step(conv_id, row, etag, "lab")


def summaries(svc: ModelFailoverService, conv_id: str) -> list[Step]:
    return [s for s in steps_of(svc, conv_id) if s.kind == "summary"]


def small(at: float = 0.7, ceiling: int = 60000, keep: int = 1) -> Compaction:
    return Compaction(at, ceiling, keep, HAIKU)


def test_history_is_compacted_at_the_ceiling_and_the_originals_stay() -> None:
    svc, fake = make({HAIKU: [[text("They asked five questions about leave.")]], SONNET: [[text("Noted.")]]},
                     cfg=small(ceiling=2000))
    conv = new_conv(svc)
    seed(svc, conv, 5, words=300, ticket_in=1)
    assert svc.memory(steps_of(svc, conv), small(ceiling=2000))["threshold"] == 2000  # the ceiling, not 0.7 of 200,000
    evs = talk(svc, conv, "One more question")
    note = kinds(evs, "compaction")[0]["step"]
    assert note["kind"] == "summary" and note["model"] == HAIKU and note["covers_from"] == "000000-00"
    [summary] = summaries(svc, conv)
    assert summary.covers_until == "000004-01" and "five questions" in summary.content[0]["text"]
    assert "ticket NW-1001" in summary.content[0]["text"]  # written by code, so a summary cannot forget a write
    assert len([s for s in steps_of(svc, conv) if s.kind != "summary"]) == 5 * 2 + 2 + 2  # nothing was deleted
    sent = fake.calls[-1]["messages"]  # the answering model got the summary and the last turn, word for word
    assert fake.calls[-1]["model"] == SONNET and len(sent) == 1
    assert [b["type"] for b in sent[0]["content"]] == ["text", "text"] and "Summary of the earlier" in sent[0]["content"][0]["text"]
    assert sent[0]["content"][1]["text"] == "One more question"


def test_the_fraction_of_the_window_triggers_it_and_a_short_history_does_not() -> None:
    pools = [Pool(SONNET, SONNET, "anthropic", 4000), Pool(HAIKU, HAIKU, "anthropic", 4000)]
    svc, fake = make({HAIKU: [[text("Summary.")]], SONNET: [[text("a")], [text("b")]]}, pools=pools, cfg=small(at=0.5))
    conv = new_conv(svc)
    talk(svc, conv, "short")
    assert summaries(svc, conv) == []
    seed(svc, conv, 3, words=400)
    talk(svc, conv, "again")
    assert len(summaries(svc, conv)) == 1
    assert svc.memory(steps_of(svc, conv), small(at=0.5))["threshold"] == 2000


def test_a_switch_to_a_smaller_window_model_compacts() -> None:
    pools = [Pool(SONNET, SONNET, "anthropic", 200_000), Pool(HAIKU, HAIKU, "anthropic", 3000)]
    svc, fake = make({HAIKU: [[text("Short summary.")], [text("Answer from haiku.")]]}, pools=pools, cfg=small(at=0.7))
    conv = new_conv(svc)
    seed(svc, conv, 4, words=300)
    svc.router.inject(SONNET, "529")
    evs = talk(svc, conv, "What now?")
    assert kinds(evs, "switch") and len(kinds(evs, "compaction")) == 1
    assert kinds(evs, "done")[0]["model"] == HAIKU and len(summaries(svc, conv)) == 1
    assert fake.models_called() == [HAIKU, HAIKU]  # the summary, then the answer; sonnet was never sent anything


def history_is_whole(messages: list[dict]) -> bool:
    ids, answered = [], set()
    for m in messages:
        for b in m["content"]:
            if b.get("type") == "tool_use":
                ids.append(b["id"])
            if b.get("type") == "tool_result":
                answered.add(b["tool_use_id"])
    return set(ids) == answered and messages[0]["role"] == "user"


def test_the_cut_is_between_turns_so_a_tool_use_is_never_parted_from_its_result() -> None:
    svc, _ = make({})
    conv = new_conv(svc)
    seed(svc, conv, 6, ticket_in=2)
    steps = steps_of(svc, conv)
    for keep in range(1, 6):
        cut = mf.compaction_cut(steps, keep)
        assert cut is not None and steps[cut].kind == "user" and steps[cut].turn == 6 - keep
        assert history_is_whole(mf.build_messages(steps[cut:], Pool(SONNET, SONNET, "anthropic")))
    assert mf.compaction_cut(steps, 6) is None and mf.compaction_cut(steps, 20) is None
    broken = [s for s in steps if s.key != "000002-02"]  # a tool_use whose result is missing, before the cut
    assert mf.compaction_cut(broken, 1) is None


def test_repeated_compaction_summarises_the_previous_summary_and_keeps_the_actions() -> None:
    svc, fake = make({HAIKU: [[text("First summary.")], [text("Second summary.")]], SONNET: [[text("a")], [text("b")]]},
                     cfg=small(ceiling=1500))
    conv = new_conv(svc)
    seed(svc, conv, 4, words=200, ticket_in=0)
    talk(svc, conv, "round one")
    seed(svc, conv, 3, words=200)
    talk(svc, conv, "round two")
    first, second = summaries(svc, conv)
    assert second.covers_from == first.covers_from == "000000-00" and second.covers_until > first.covers_until
    summary_call = fake.calls[2]  # the second summary: haiku was shown the first summary
    assert "First summary." in summary_call["messages"][0]["content"][0]["text"]
    assert "ticket NW-1001" in second.content[0]["text"] and "Second summary." in second.content[0]["text"]
    assert len(fake.calls[-1]["messages"]) == 1 and "Second summary." in fake.calls[-1]["messages"][0]["content"][0]["text"]


@pytest.mark.parametrize("bad", [([], "end_turn"), ([text("Sorry.")], "refusal"), ([text("Half a summ")], "max_tokens"),
                                 status_error(400)])
def test_an_empty_refused_or_cut_off_summary_leaves_the_history_alone(bad: Any) -> None:
    svc, fake = make({HAIKU: [bad, bad], SONNET: [[text("Answered with everything.")]]}, cfg=small(ceiling=1500))
    conv = new_conv(svc)
    seed(svc, conv, 4, words=200)
    evs = talk(svc, conv, "carry on")
    assert kinds(evs, "compaction_failed") and kinds(evs, "done")[0]["reply"] == "Answered with everything."
    assert summaries(svc, conv) == []
    assert len(fake.calls[-1]["messages"]) == 4 * 2 + 1  # the full history still fits, so the full history was sent


def test_a_failed_summary_with_a_history_that_does_not_fit_fails_the_turn_clearly() -> None:
    pools = [Pool(SONNET, SONNET, "anthropic", 3000), Pool(HAIKU, HAIKU, "anthropic", 3000)]
    svc, fake = make({HAIKU: [([], "end_turn")], SONNET: []}, pools=pools, cfg=small())
    conv = new_conv(svc)
    seed(svc, conv, 4, words=300)
    evs = talk(svc, conv, "carry on")
    assert "context_too_long" not in json.dumps(evs) and "could not be shortened" in kinds(evs, "error")[0]["message"]
    assert summaries(svc, conv) == [] and fake.models_called() == [HAIKU]
    assert len(steps_of(svc, conv)) == 4 * 2 + 1  # intact, with the user's message saved


def test_two_compactions_at_once_one_wins_and_the_other_is_busy() -> None:
    gate, entered = threading.Event(), threading.Event()

    def slow() -> list[dict]:
        entered.set()
        gate.wait(5)
        return [text("Summary.")]

    svc, fake = make({HAIKU: [slow]}, cfg=small())
    conv = new_conv(svc)
    seed(svc, conv, 4, words=5)
    results: list[Any] = []
    thread = threading.Thread(target=lambda: results.append(svc.compact_now(conv)))
    thread.start()
    assert entered.wait(5)
    with pytest.raises(ApiError) as caught:
        svc.compact_now(conv)
    assert caught.value.status == 409
    gate.set()
    thread.join()
    assert len(summaries(svc, conv)) == 1 and results[0]["memory"]["compactions"] == 1


def test_the_etag_lets_only_one_of_two_stale_compactors_write() -> None:
    svc, fake = make({HAIKU: [[text("One.")], [text("Two.")]]}, cfg=small())
    conv = new_conv(svc)
    seed(svc, conv, 4, words=5)
    loaded = svc.store.load(conv)
    a = mf._Turn(svc, conv, "lab", list(loaded.steps), loaded.etag, small(), None, None)
    b = mf._Turn(svc, conv, "lab", list(loaded.steps), loaded.etag, small(), None, None)
    assert svc.compact(a) is not None
    with pytest.raises(Conflict):
        svc.compact(b)
    assert len(summaries(svc, conv)) == 1


def test_compact_now_needs_something_to_compact() -> None:
    svc, _ = make({}, cfg=small(keep=4))
    conv = new_conv(svc)
    seed(svc, conv, 3)
    with pytest.raises(ApiError) as caught:
        svc.compact_now(conv)
    assert caught.value.status == 400 and caught.value.kind == "nothing_to_compact"


def test_overrides_are_checked_and_stored_on_the_conversation() -> None:
    for bad in ({"compact_at": 0.1}, {"compact_at": 0.99}, {"compact_max_tokens": 3999}, {"keep_recent": 0}, {"keep_recent": 21}):
        with pytest.raises(ApiError) as caught:
            mf.check_overrides(bad)
        assert caught.value.status == 400
    svc, _ = make({})
    conv = new_conv(svc)
    got = svc.set_overrides(conv, {"compact_at": 0.5, "compact_max_tokens": None, "keep_recent": 2})
    assert got["conversation"]["overrides"] == {"compact_at": 0.5, "keep_recent": 2}
    assert got["memory"]["settings"]["keep_recent"] == 2 and got["memory"]["settings"]["compact_max_tokens"] == 60000
    assert got["memory"]["defaults"]["keep_recent"] == 4


# ----- the routes -----

def lab(tmp_path: Path, script: dict[str, list[Any]]) -> tuple[TestClient, Fake]:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><div id=root></div>")
    settings = Settings(port=8000, budget_usd=2.0, frontend_dist=dist, models_dir=tmp_path / "no-models",
                        generated_dir=tmp_path / "generated")
    fake = Fake(script)
    return TestClient(create_app(settings, client=fake), base_url="http://localhost:8000"), fake


def test_the_routes_run_a_conversation_and_show_the_model_of_each_step(tmp_path: Path) -> None:
    api, fake = lab(tmp_path, {HAIKU: [[use("search_handbook", {"query": "leave"})], [text("25 days.")]]})
    info = api.get("/api/model-failover/info", headers=LAB).json()
    assert [p["name"] for p in info["router"]["pools"]] == [SONNET, HAIKU] and info["storage"]["kind"] == "files"
    conv = api.post("/api/model-failover/conversations", headers=LAB).json()["id"]
    r = api.post(f"/api/model-failover/conversations/{conv}/messages", headers=LAB,
                 json={"message": "Annual leave?", "primary": HAIKU})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
    lines = [json.loads(x) for x in r.text.splitlines() if x.strip()]
    assert lines[0]["type"] == "run" and lines[-1]["type"] == "done" and lines[-1]["reply"] == "25 days."
    got = api.get(f"/api/model-failover/conversations/{conv}", headers=LAB).json()
    assert [(s["kind"], s["model"]) for s in got["steps"]] == [("user", ""), ("model", HAIKU), ("tool", ""), ("model", HAIKU)]
    assert got["storage"]["blobs"][0].endswith("000000-00.json") and got["memory"]["tokens"] > 0
    assert got["conversation"]["title"] == "Annual leave?" and got["conversation"]["status"] == "idle"
    assert conv in [c["id"] for c in api.get("/api/model-failover/conversations", headers=LAB).json()["conversations"]]
    assert api.get("/api/status").json()["spent_usd"] > 0
    assert api.delete(f"/api/model-failover/conversations/{conv}", headers=LAB).status_code == 200
    assert api.get(f"/api/model-failover/conversations/{conv}", headers=LAB).status_code == 404


def test_the_routes_validate_input_and_both_guards_apply(tmp_path: Path) -> None:
    api, fake = lab(tmp_path, {})
    conv = api.post("/api/model-failover/conversations", headers=LAB).json()["id"]
    base = f"/api/model-failover/conversations/{conv}"
    for body in ({"message": ""}, {"message": "x" * 1501}, {"message": "hi", "primary": "gpt-nope"}):
        assert api.post(f"{base}/messages", headers=LAB, json=body).status_code == 400
    assert api.post("/api/model-failover/conversations/NOT-AN-ID/messages", headers=LAB, json={"message": "hi"}).status_code == 400
    for body in ({"pool": "nope", "kind": "429"}, {"pool": SONNET, "kind": "418"}, {"pool": SONNET, "kind": "429", "count": 11},
                 {"pool": SONNET, "kind": "429", "count": 0}):
        assert api.post("/api/model-failover/faults", headers=LAB, json=body).status_code == 400
    for body in ({"compact_at": 0.1}, {"compact_at": 0.96}, {"compact_max_tokens": 100}, {"keep_recent": 0}, {"keep_recent": 21}):
        assert api.put(f"{base}/settings", headers=LAB, json=body).status_code == 400
    ok = api.put(f"{base}/settings", headers=LAB, json={"compact_at": 0.5, "keep_recent": 2})
    assert ok.status_code == 200 and ok.json()["memory"]["settings"]["compact_at"] == 0.5
    assert api.delete("/api/model-failover/faults?pool=nope", headers=LAB).status_code == 400
    assert api.post(f"{base}/compact", headers=LAB, json={}).status_code == 400  # nothing to compact
    # the guards
    assert api.post(f"{base}/messages", json={"message": "hi"}).status_code == 403
    assert api.post(f"{base}/messages", json={"message": "hi"}, headers={"x-llm-lab": "1", "host": "evil.example:8000"}).status_code == 403
    assert api.post("/api/model-failover/faults", json={"pool": SONNET, "kind": "429"}).status_code == 403
    assert fake.calls == []
    over, _ = lab(tmp_path / "b", {})
    over.app.state.container.spend.budget_usd = 0
    conv2 = over.post("/api/model-failover/conversations", headers=LAB).json()["id"]
    assert over.post(f"/api/model-failover/conversations/{conv2}/messages", headers=LAB, json={"message": "hi"}).status_code == 429


def test_fault_injection_through_the_routes_switches_and_the_status_shows_the_breaker(tmp_path: Path) -> None:
    api, fake = lab(tmp_path, {HAIKU: [[text("From haiku.")]]})
    status = api.post("/api/model-failover/faults", headers=LAB, json={"pool": SONNET, "kind": "429", "count": 3}).json()
    assert status["pools"][0]["faults"] == ["429", "429", "429"]
    conv = api.post("/api/model-failover/conversations", headers=LAB).json()["id"]
    r = api.post(f"/api/model-failover/conversations/{conv}/messages", headers=LAB, json={"message": "Hi", "primary": SONNET})
    lines = [json.loads(x) for x in r.text.splitlines() if x.strip()]
    switch = next(e for e in lines if e["type"] == "switch")
    assert switch["from"] == SONNET and switch["to"] == HAIKU and switch["injected"] is True
    after = api.get("/api/model-failover/router", headers=LAB).json()["pools"][0]
    assert after["state"] == "open" and after["retry_in_s"] > 0 and after["faults"] == ["429", "429"]
    assert fake.models_called() == [HAIKU]  # the injected faults sent nothing to Claude
    reset = api.post("/api/model-failover/router/reset", headers=LAB).json()["pools"][0]
    assert reset["state"] == "closed" and reset["faults"] == []


def test_the_example_registry_entry_page_exists() -> None:
    root = Path(__file__).resolve().parents[2]
    assert (root / "frontend" / "src" / "pages" / "model-failover" / "ModelFailoverPage.tsx").exists()


def test_compact_now_on_a_finished_conversation_leaves_it_finished() -> None:
    """A summary step can come last; the conversation is still whole, so Resume makes no (paid) model call."""
    svc, fake = make({HAIKU: [[text("Summary.")]]}, cfg=small())
    conv = new_conv(svc)
    seed(svc, conv, 4, words=5)
    svc.compact_now(conv)
    steps = steps_of(svc, conv)
    assert steps[-1].kind == "summary" and not svc.incomplete(steps)
    calls = len(fake.calls)
    with pytest.raises(ApiError) as caught:
        svc.resume(conv)
    assert caught.value.kind == "nothing_to_resume" and len(fake.calls) == calls


def test_a_whitespace_only_message_is_refused_and_never_stored() -> None:
    """An empty text block would make the API refuse every later call, so the conversation would be stuck."""
    svc, fake = make({})
    conv = new_conv(svc)
    with pytest.raises(ApiError) as caught:
        svc.send(conv, "   \n ")
    assert caught.value.status == 400 and steps_of(svc, conv) == [] and fake.calls == []


def test_a_history_too_long_for_one_pool_moves_on_to_a_bigger_window() -> None:
    """A 413 for a small window is not a failure of the model: the next pool with room answers, no breaker opens."""
    pools = [Pool(HAIKU, HAIKU, "anthropic", 3000, "small window"), Pool(SONNET, SONNET, "anthropic", 200_000, "big")]
    svc, fake = make({SONNET: [[text("Answered by the big window.")]]}, pools=pools, cfg=Compaction(model=HAIKU, keep_recent=20))
    conv = new_conv(svc)
    seed(svc, conv, 2, words=900)  # far more than 3000 tokens, nothing old enough to compact
    evs = talk(svc, conv, "carry on", primary=HAIKU)
    assert kinds(evs, "done")[0]["reply"] == "Answered by the big window."
    assert fake.models_called() == [SONNET]
    assert {p["name"]: p["state"] for p in svc.router.status()["pools"]}[HAIKU] == "closed"


def test_reset_survives_a_breaker_left_by_a_pool_that_was_removed() -> None:
    router = ModelRouter(default_pools(), cooldown_s=30, sleep=lambda s: None)
    with router._lock:
        router._b("removed-mid-call")  # what an in-flight call to a deleted pool leaves behind
    router.reset()  # used to raise KeyError
    assert router.status()


def test_a_turn_whose_stream_is_never_read_does_not_hold_the_conversation() -> None:
    """The page went before reading the stream: the work never ran, so the claim lapses after START_GRACE_S."""
    svc, fake = make({SONNET: [[text("Hello.")]]})
    now = [1000.0]
    svc._now = lambda: now[0]
    conv = new_conv(svc)
    svc.send(conv, "hi")  # the generator is never iterated
    with pytest.raises(ApiError) as caught:
        svc.resume(conv)
    assert caught.value.status == 409  # still within the grace period
    now[0] += mf.START_GRACE_S + 1
    evs = events(svc.resume(conv))  # the saved user step is answered
    assert kinds(evs, "done")[0]["reply"] == "Hello." and fake.calls


def test_a_running_turn_keeps_its_claim_past_the_grace_period() -> None:
    svc, _ = make({})
    now = [1000.0]
    svc._now = lambda: now[0]
    conv = new_conv(svc)
    svc._claim(conv, started=False)
    svc._started(conv)
    now[0] += mf.START_GRACE_S + 60
    assert svc.busy(conv)


def test_a_reply_from_a_model_with_no_price_is_still_counted() -> None:
    """A real call must never count as $0: the run cap and the budget would never trip."""
    pools = [Pool("mystery", "mystery-model-1", "anthropic", 200_000, "no price anywhere")]
    svc, fake = make({"mystery-model-1": [[text("Hi.")]]}, pools=pools)
    conv = new_conv(svc)
    evs = talk(svc, conv, "hello", primary="mystery")
    assert kinds(evs, "done")[0]["cost_usd"] > 0 and svc.spend.spent_usd > 0


def test_a_summary_that_covers_every_step_is_still_sent() -> None:
    """With nothing after it, the summary is the whole history; dropping it would send an empty request."""
    user = Step(0, 0, "user", "user", [text("What is the meal limit?")])
    reply = Step(0, 1, "model", "assistant", [text("£35 a day.")], model=SONNET)
    summary = Step(0, 2, "summary", "user", [text("Summary: the caller asked about meals; the limit is £35 a day.")],
                   covers_from=user.key, covers_until=reply.key)
    messages = mf.build_messages([user, reply, summary], default_pools()[0])
    assert messages == [{"role": "user", "content": [text("Summary: the caller asked about meals; the limit is £35 a day.")]}]


def test_the_ticket_file_is_written_whole_and_a_damaged_one_is_kept(tmp_path: Path) -> None:
    path = tmp_path / "tickets.json"
    desk = TicketDesk(path)
    first, _ = desk.create("key-1", "Laptop")
    assert json.loads(path.read_text())["key-1"]["ticket"] == first["ticket"] == "NW-1001"
    again, existed = TicketDesk(path).create("key-1", "Laptop")  # the key survives a restart
    assert existed and again["ticket"] == "NW-1001"
    path.write_text("{ half written")
    fresh = TicketDesk(path)
    assert (tmp_path / "tickets.json.unreadable").read_text() == "{ half written"  # kept, not overwritten
    assert fresh.create("key-2", "Monitor")[0]["ticket"] == "NW-1001"


def test_ticket_numbers_never_repeat_after_a_ticket_is_gone(tmp_path: Path) -> None:
    desk = TicketDesk(tmp_path / "t.json")
    desk.create("a", "one")
    desk.create("b", "two")
    del desk.tickets["a"]
    assert desk.create("c", "three")[0]["ticket"] == "NW-1003"


def test_once_the_page_has_gone_no_further_model_call_is_made() -> None:
    """A 529 would switch to the next pool, but the page left during the failed call: nothing more is paid for."""
    from backend.app.services.runs import Run

    run = Run()

    def page_leaves_then_overloaded() -> BaseException:
        run.cancelled.set()
        return status_error(529)

    svc, fake = make({SONNET: [page_leaves_then_overloaded], HAIKU: [[text("Should never be asked.")]]})
    conv = new_conv(svc)
    seed(svc, conv, 1)
    loaded = svc.store.load(conv)
    t = mf._Turn(svc, conv, "lab", list(loaded.steps), loaded.etag, Compaction(model=HAIKU), SONNET, run)
    t.append(Step(1, 0, "user", "user", [text("one more")]))
    out = svc.drive(t)
    assert out["stop_reason"] == "cancelled" and fake.models_called() == [SONNET]


def test_an_error_event_carries_the_cost_of_the_calls_already_made() -> None:
    """The first call (a tool use) is charged; the second fails with no pool left. The page must still count the first."""
    svc, _ = make({SONNET: [[use("search_handbook", {"query": "meals"})], status_error(400)]})
    conv = new_conv(svc)
    evs = talk(svc, conv, "meal limit?")
    error = kinds(evs, "error")[0]
    assert error["can_resume"] and error["cost_usd"] > 0


# ----- review findings, second pass -----

def test_reading_a_conversation_part_way_through_a_write_does_not_break_the_writer(store: Any) -> None:
    """The page polls while a turn runs. A read between claiming a step and writing its blob used to 'repair' the row,
    which moved the ETag the running turn held, so its next step failed with Conflict and the run died."""
    conv = store.create("lab")
    etag = store.append_step(conv.id, user_step(0), conv.etag, "lab")
    original, seen = store._blob_put, []

    def page_polls_mid_write(path: str, data: str) -> None:
        seen.append(store.load(conv.id).last_step)  # the row already points at the new step; its blob is not there yet
        original(path, data)

    store._blob_put = page_polls_mid_write
    try:
        etag = store.append_step(conv.id, Step(0, 1, "model", "assistant", [text("hi")]), etag, "lab")
    finally:
        store._blob_put = original
    store.append_step(conv.id, user_step(1), etag, "lab")  # the writer's ETag is still good
    assert seen == ["000000-00"] and len(store.load(conv.id).steps) == 3
    store.delete(conv.id, "lab")


def test_a_call_made_inside_a_half_open_probe_may_use_that_pool() -> None:
    """Compaction runs inside the probe's request. It must not be refused the pool the probe holds (and sent elsewhere,
    or failed when every other pool is down) while that pool is recovering."""
    clock = Clock()
    router = two_pools(clock)
    router.inject("a", "529", 1)
    router.inject("b", "529", 1)
    with pytest.raises(AllPoolsFailed):
        router.call(lambda p: p.name)  # both open
    clock.now += 31  # both half-open
    router.inject("b", "529", 1)  # and b is still failing
    inner: list[str] = []

    def probe(pool: Pool) -> str:
        inner.append(router.call(lambda p: p.name, "a").result)  # the summary, from inside the probe
        return pool.name

    assert router.call(probe, "a").result == "a" and inner == ["a"]
    assert router.status()["pools"][0]["state"] == "closed"


def test_a_spent_budget_is_a_402_that_offers_no_resume() -> None:
    """The lab's whole budget is not the run's cap: Resume would only be refused, so the page must not offer it."""
    svc, fake = make({SONNET: [[text("Never asked.")]]})
    conv = new_conv(svc)
    svc.spend.spent_usd = svc.spend.budget_usd
    error = kinds(talk(svc, conv, "hello"), "error")[0]
    assert not error["can_resume"] and "spending cap" in error["message"] and fake.models_called() == []


# ----- review findings, third pass -----

def test_a_turn_past_its_hundredth_step_keeps_its_order(store: Any) -> None:
    """Keys are {turn:06d}-{step:02d} and the stores list them as text, where 000000-100 comes before 000000-99. A
    turn resumed many times can get there, and a summary would then drop or repeat the wrong steps."""
    conv = store.create("lab")
    etag = conv.etag
    for n in range(102):
        etag = store.append_step(conv.id, Step(0, n, "user" if n == 0 else "tool", "user", [text(f"step {n}")]), etag, "lab")
    steps = store.load(conv.id).steps
    assert [s.step for s in steps] == list(range(102)) and store.load(conv.id).last_step == "000000-101"
    summary = Step(0, 102, "summary", "user", [text("Summary.")], covers_from="000000-00", covers_until="000000-99")
    _, vis = mf.visible(steps + [summary])
    assert [s.step for s in vis] == [100, 101]
    store.delete(conv.id, "lab")


def test_a_probe_interrupted_by_a_base_exception_is_released() -> None:
    """An interrupt mid-probe skipped `except Exception`, so the pool showed 'a probe is in flight' for good."""
    clock = Clock()
    router = two_pools(clock)
    router.inject("a", "529", 1)
    router.call(lambda p: p.name)
    clock.now += 31

    def interrupted(pool: Pool) -> str:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        router.call(interrupted, "a")
    assert router.call(lambda p: p.name, "a").result == "a"  # the next call may probe


def test_a_page_that_leaves_during_a_summary_is_a_cancel_not_a_failed_summary() -> None:
    from backend.app.services.runs import Run

    svc, fake = make({HAIKU: [[text("Never asked.")]]}, cfg=small(keep=1))
    conv = new_conv(svc)
    seed(svc, conv, 3)
    loaded, run = svc.store.load(conv), Run()
    t = mf._Turn(svc, conv, "lab", list(loaded.steps), loaded.etag, small(keep=1), SONNET, run)
    seen: list[dict] = []
    t.emit = seen.append  # type: ignore[method-assign]
    run.cancelled.set()
    with pytest.raises(mf.RunCancelled):
        svc.compact(t)
    assert not t.compaction_failed and seen == [] and fake.models_called() == []


def test_the_status_is_reset_after_the_row_changed_under_the_turn() -> None:
    """After a Conflict the turn's ETag is stale; the row was left 'running' for good."""
    svc, _ = make({})
    conv = new_conv(svc)
    seed(svc, conv, 1)
    loaded = svc.store.load(conv)
    t = mf._Turn(svc, conv, "lab", list(loaded.steps), loaded.etag, Compaction(), SONNET, None)
    svc.store.update_meta(conv, loaded.etag, status="running", user_id="lab")  # someone else moved the ETag on
    svc._set_status(t, "failed")
    assert svc.store.load(conv).status == "failed"


def test_the_limits_and_router_timings_come_from_the_environment() -> None:
    """Reply and summary lengths, the call cap and the router's timings are settings (.env), not constants; out of range
    values are clamped, and the router and service built by the container use them."""
    from backend.app.shared import EnvSettings

    env = EnvSettings.from_env({"MODEL_FAILOVER_MAX_TOKENS": "2048", "MODEL_FAILOVER_SUMMARY_MAX_TOKENS": "900",
                                "MODEL_FAILOVER_MAX_ITERATIONS": "50", "MODEL_FAILOVER_COOLDOWN_S": "12",
                                "MODEL_FAILOVER_MAX_COOLDOWN_S": "5", "MODEL_FAILOVER_SHORT_RETRY_S": "0",
                                "MODEL_FAILOVER_KEEP_RECENT": "2", "MODEL_FAILOVER_COMPACT_MAX_TOKENS": "8000"})
    assert (env.model_failover_max_tokens, env.model_failover_summary_max_tokens, env.model_failover_max_iterations) == (2048, 900, 20)
    assert env.model_failover_short_retry_s == 0.0 and env.model_failover_keep_recent == 2
    settings = Settings(model_failover_max_tokens=2048, model_failover_summary_max_tokens=900, model_failover_max_iterations=2,
                        model_failover_cooldown_s=12, model_failover_max_cooldown_s=60, model_failover_short_retry_s=0,
                        model_failover_keep_recent=2, model_failover_compact_max_tokens=8000)
    router = ModelRouter(default_pools(), cooldown_s=settings.model_failover_cooldown_s, sleep=lambda s: None,
                         max_cooldown_s=settings.model_failover_max_cooldown_s, short_retry_s=settings.model_failover_short_retry_s)
    fake = Fake({SONNET: [status_error(429, "1")], HAIKU: [[use("search_handbook", {"query": "leave"})],
                                                           [use("search_handbook", {"query": "leave"}, 2)]]})
    svc = ModelFailoverService(ClaudeGateway(fake), SpendTracker(5.0), RunStreamer(RunRegistry(), 1.0), MemoryStore(), router,
                               Compaction.from_settings(settings), TicketDesk(), limits=mf.Limits.from_settings(settings))
    evs = talk(svc, new_conv(svc), "leave?")
    assert kinds(evs, "retry") == [] and kinds(evs, "switch")  # a 1 s wait is no longer retried: short_retry_s is 0
    assert kinds(evs, "done")[0]["stop_reason"] == "iteration_cap"  # after two calls, not six
    assert {c["max_tokens"] for c in fake.calls} == {2048}
    status = router.status()
    assert status["cooldown_s"] == 12 and status["max_cooldown_s"] == 60 and status["short_retry_s"] == 0
    assert svc.info()["limits"]["iterations"] == 2 and svc.config(None).keep_recent == 2
    assert Settings.from_env().model_failover_max_cooldown_s >= Settings.from_env().model_failover_cooldown_s
