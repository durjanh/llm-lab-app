"""Fake chat clients, no network and no cost: the fallback client's rules, the history provider and compaction."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest
from agent_framework import Agent, AgentSession, BaseChatClient, ChatResponse, Content, Message

sys.path.insert(0, str(Path(__file__).resolve().parent))
from failover import (BlobTableHistoryProvider, FailoverExhausted, FallbackChatClient, InjectFaults)  # noqa: E402
from rules import CompactSettings, Fault  # noqa: E402

import lab_store  # noqa: E402


class Scripted(BaseChatClient):
    """Answers from a script: text, an exception to raise, or (text, finish_reason)."""

    def __init__(self, name: str, script: list[Any]):
        super().__init__()
        self.name, self.script, self.seen = name, list(script), []

    def _inner_get_response(self, *, messages, stream, options, **kwargs):
        async def go() -> ChatResponse:
            self.seen.append([m.text for m in messages])
            entry = self.script.pop(0)
            if isinstance(entry, BaseException):
                raise entry
            text, finish = entry if isinstance(entry, tuple) else (entry, "stop")
            return ChatResponse(messages=[Message("assistant", [Content.from_text(text)])], model=self.name, finish_reason=finish)
        return go()


def ask(client: Any, text: str = "hi") -> ChatResponse:
    return asyncio.run(client.get_response([Message("user", [Content.from_text(text)])]))


def fallback(a: list[Any], b: list[Any], **kw: Any) -> tuple[FallbackChatClient, Scripted, Scripted, list[dict]]:
    events: list[dict] = []

    async def no_sleep(_: float) -> None:
        return None

    first, second = Scripted("claude", a), Scripted("gpt", b)
    return FallbackChatClient([("claude", first), ("gpt", second)], sleep=no_sleep, on_event=events.append, **kw), first, second, events


def test_a_long_429_switches_and_the_second_client_gets_the_same_messages() -> None:
    client, claude, gpt, events = fallback([Fault(429, 30.0)], ["from gpt", "gpt again"])
    r = ask(client, "what is the leave policy?")
    assert r.text == "from gpt" and r.additional_properties["fallback_from"] == "claude"
    assert claude.seen == gpt.seen == [["what is the leave policy?"]]
    assert events == [{"type": "switch", "from": "claude", "reason": "429, retry-after 30 s"}]
    assert client.breakers["claude"].state == "open"
    assert ask(client).text == "gpt again" and len(claude.seen) == 1  # claude's breaker is open: not tried again


def test_a_short_429_is_retried_once_on_the_same_client() -> None:
    client, claude, gpt, events = fallback([Fault(429, 1.0), "ok"], [])
    assert ask(client).text == "ok" and len(claude.seen) == 2 and gpt.seen == []
    assert [e["type"] for e in events] == ["retry"]


@pytest.mark.parametrize("status", [529, 503, 500])
def test_overload_and_server_errors_switch(status: int) -> None:
    client, claude, gpt, _ = fallback([Fault(status)], ["gpt answer"])
    assert ask(client).text == "gpt answer"


def test_a_timeout_switches() -> None:
    client, *_ = fallback([TimeoutError()], ["gpt answer"])
    assert ask(client).text == "gpt answer"


@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_a_client_error_is_raised_and_never_switches(status: int) -> None:
    client, claude, gpt, _ = fallback([Fault(status)], ["never"])
    with pytest.raises(Fault):
        ask(client)
    assert gpt.seen == [] and client.breakers["claude"].state == "closed"


def test_the_breaker_half_opens_after_the_cooldown() -> None:
    now = [100.0]
    client, claude, gpt, _ = fallback([Fault(529), "claude is back"], ["g1", "g2"], cooldown_s=30, clock=lambda: now[0])
    assert ask(client).text == "g1"
    assert ask(client).text == "g2" and len(claude.seen) == 1
    now[0] += 31
    assert client.breakers["claude"].state == "half-open"
    assert ask(client).text == "claude is back" and client.breakers["claude"].state == "closed"


def test_everything_failing_says_what_each_said() -> None:
    client, *_ = fallback([Fault(529)], [Fault(429, 30.0)])
    with pytest.raises(FailoverExhausted) as caught:
        ask(client)
    assert "claude: 529" in str(caught.value) and "gpt: 429" in str(caught.value)


def test_inject_faults_fail_before_the_wrapped_client_is_called() -> None:
    inner = Scripted("claude", ["fine"])
    wrapped = InjectFaults(inner, [(429, 30.0)])
    with pytest.raises(Fault):
        ask(wrapped)
    assert inner.seen == [] and ask(wrapped).text == "fine"


# ----- history -----

def test_the_provider_keeps_the_conversation_in_the_lab_layout_and_the_session_holds_only_an_id(tmp_path: Path) -> None:
    store = lab_store.FileStore(tmp_path)
    provider = BlobTableHistoryProvider(store)
    claude = Scripted("claude", [Fault(529), "second answer"])
    gpt = Scripted("gpt", ["first answer"])
    client = FallbackChatClient([("claude", claude), ("gpt", gpt)], cooldown_s=0)
    agent = Agent(client, "You are brief.", context_providers=[provider])
    session = AgentSession(session_id="demo-session")
    assert asyncio.run(agent.run("first question", session=session)).text == "first answer"
    assert asyncio.run(agent.run("second question", session=session)).text == "second answer"
    assert session.to_dict() == {"type": "session", "session_id": "demo-session", "service_session_id": None, "state": session.state}
    assert "first answer" not in str(session.to_dict())  # no history in the session
    sent = claude.seen[-1]
    assert "first question" in sent and "first answer" in sent  # claude, back after the switch, saw gpt's answer from the store
    conv_id = lab_store.conv_id_for("demo-session")
    steps = store.load(conv_id).steps
    assert [(s.kind, s.turn, s.step) for s in steps] == [("user", 0, 0), ("model", 0, 1), ("user", 1, 0), ("model", 1, 1)]
    assert store.rows(conv_id)["blobs"][0].endswith("steps/000000-00.json")


def stored(provider: BlobTableHistoryProvider, turns: int, words: int = 200) -> None:
    for n in range(turns):
        pad = " lorem ipsum" * words
        asyncio.run(provider.save_messages("s", [Message("user", [Content.from_text(f"question {n}{pad}")])]))
        asyncio.run(provider.save_messages("s", [Message("assistant", [Content.from_text(f"answer {n}")])]))


def test_get_messages_compacts_over_the_ceiling_and_keeps_the_originals(tmp_path: Path) -> None:
    store = lab_store.FileStore(tmp_path)
    summariser = Scripted("haiku", ["They asked three questions."])
    provider = BlobTableHistoryProvider(store, summariser, CompactSettings(0.7, 1500, 1, "claude-haiku-5-5"))
    stored(provider, 4)
    messages = asyncio.run(provider.get_messages("s"))
    assert [m.role for m in messages] == ["user", "user", "assistant"]
    assert "three questions" in messages[0].text and "question 3" in messages[1].text
    steps = store.load(lab_store.conv_id_for("s")).steps
    assert len([s for s in steps if s.kind != "summary"]) == 8 and [s.kind for s in steps].count("summary") == 1
    summary = next(s for s in steps if s.kind == "summary")
    assert (summary.covers_from, summary.covers_until) == ("000000-00", "000002-01")
    again = asyncio.run(provider.get_messages("s"))  # now under the threshold: no second summary
    assert len(again) == 3 and [s.kind for s in store.load(lab_store.conv_id_for("s")).steps].count("summary") == 1


@pytest.mark.parametrize("bad", ["", ("Sorry.", "content_filter"), ("Half a summ", "length"), Fault(529)])
def test_a_bad_summary_leaves_the_full_history_in_use(tmp_path: Path, bad: Any) -> None:
    provider = BlobTableHistoryProvider(lab_store.FileStore(tmp_path), Scripted("haiku", [bad]),
                                        CompactSettings(0.7, 1500, 1, "claude-haiku-5-5"))
    stored(provider, 4)
    messages = asyncio.run(provider.get_messages("s"))
    assert len(messages) == 8 and provider.events[0]["type"] == "compaction_failed"
    assert not [s for s in provider.store.load(lab_store.conv_id_for("s")).steps if s.kind == "summary"]


def test_model_names_come_from_the_lab_catalog(monkeypatch):
    import catalog
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.invalid")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENTS", "gpt-test-1, gpt-image-1")
    found = catalog.models()
    assert found[0]["provider"] == "anthropic" and [m["name"] for m in found if m["provider"] == "azure-openai"] == ["gpt-test-1"]
    assert catalog.first("anthropic")["model"] and CompactSettings.from_env().model == catalog.compact_model()
    monkeypatch.delenv("AZURE_OPENAI_ENDPOINT")
    assert catalog.models("azure-openai") == []
