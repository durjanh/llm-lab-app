"""Fake chat models, no network and no cost: fallbacks, the retry policy, the Blob + Table checkpointer and compaction."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.types import RetryPolicy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blob_saver import BlobTableSaver, DirBackend  # noqa: E402
from failover_graph import Switch, build_graph, failover_model  # noqa: E402
from rules import CompactSettings, Fault  # noqa: E402


class Scripted(BaseChatModel):
    """Answers from a script: text, (text, finish_reason), or an exception to raise."""
    script: list[Any]
    seen: list[list[str]] = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        self.seen.append([str(m.content) for m in messages])
        entry = self.script.pop(0)
        if isinstance(entry, BaseException):
            raise entry
        text, finish = entry if isinstance(entry, tuple) else (entry, "stop")
        return ChatResult(generations=[ChatGeneration(message=AIMessage(text, response_metadata={"finish_reason": finish}))])


def model(*script: Any) -> Scripted:
    return Scripted(script=list(script), seen=[])


def run(graph: Any, text: str, thread: str = "t1") -> dict[str, Any]:
    return graph.invoke({"messages": [HumanMessage(text)]}, {"configurable": {"thread_id": thread}})


def make(tmp_path: Path, primary: Any, fallback: Any, **kw: Any):
    events: list[dict] = []
    fast = RetryPolicy(max_attempts=2, initial_interval=0.0, jitter=False, retry_on=Switch)
    saver = BlobTableSaver(DirBackend(tmp_path))
    chat = failover_model([("claude", primary), ("gpt", fallback)], sleep=lambda s: None, events=events, **kw)
    return build_graph(chat, saver, events=events, retry=fast), saver, events


def test_a_long_429_falls_back_and_the_history_carries_over(tmp_path: Path) -> None:
    claude, gpt = model("first from claude", Fault(429, 30.0)), model("second from gpt")
    graph, saver, events = make(tmp_path, claude, gpt)
    assert run(graph, "hello")["answered_by"] == "claude"
    out = run(graph, "and now?")
    assert out["answered_by"] == "gpt" and [m.content for m in out["messages"]][-1] == "second from gpt"
    assert gpt.seen[0] == ["hello", "first from claude", "and now?"]  # the fallback saw the whole history from the checkpoint
    assert {"type": "switch", "from": "claude", "reason": "429, retry-after 30 s"} in events


def test_a_short_429_retries_the_same_model_once(tmp_path: Path) -> None:
    claude, gpt = model(Fault(429, 1.0), "claude on the retry"), model()
    graph, _, events = make(tmp_path, claude, gpt)
    assert run(graph, "hi")["answered_by"] == "claude" and gpt.seen == []
    assert events[0]["type"] == "retry"


@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_a_bad_request_is_raised_and_the_fallback_is_not_used(tmp_path: Path, status: int) -> None:
    claude, gpt = model(Fault(status)), model("never")
    graph, _, _ = make(tmp_path, claude, gpt)
    with pytest.raises(Fault):
        run(graph, "hi")
    assert gpt.seen == []


def test_the_breaker_skips_an_open_model_and_probes_after_the_cooldown(tmp_path: Path) -> None:
    now = [100.0]
    claude, gpt = model(Fault(529), "claude is back"), model("g1", "g2")
    graph, _, events = make(tmp_path, claude, gpt, clock=lambda: now[0])
    assert run(graph, "one")["answered_by"] == "gpt"
    assert run(graph, "two")["answered_by"] == "gpt" and len(claude.seen) == 1
    now[0] += 31
    assert run(graph, "three")["answered_by"] == "claude"


def test_when_every_model_fails_the_node_retries_once_and_then_resumes_from_the_checkpoint(tmp_path: Path) -> None:
    claude, gpt = model(Fault(529), "claude, second attempt"), model(Fault(503))
    graph, saver, events = make(tmp_path, claude, gpt, cooldown_s=0)
    assert run(graph, "hi")["answered_by"] == "claude"  # both failed, the node's RetryPolicy ran it again
    broken = model(Fault(400), "fixed")
    graph2, saver2, _ = make(tmp_path / "b", broken, model())
    with pytest.raises(Fault):
        run(graph2, "crash here")
    state = graph2.get_state({"configurable": {"thread_id": "t1"}})
    assert [m.content for m in state.values["messages"]] == ["crash here"] and state.next == ("agent",)
    done = graph2.invoke(None, {"configurable": {"thread_id": "t1"}})  # resume: the agent node runs again from its checkpoint
    assert done["messages"][-1].content == "fixed"


def test_the_checkpointer_keeps_blobs_and_a_table_index_and_lists_history(tmp_path: Path) -> None:
    graph, saver, _ = make(tmp_path, model("a", "b"), model())
    run(graph, "one")
    run(graph, "two")
    config = {"configurable": {"thread_id": "t1"}}
    rows = saver.backend.rows("t1")
    assert rows and all(r["blobPath"].startswith("checkpoints/t1/_/") for r in rows)
    history = list(saver.list(config))
    assert len(history) == len(rows) and history[0].metadata["step"] >= history[-1].metadata["step"]
    latest = saver.get_tuple(config)
    assert [m.content for m in latest.checkpoint["channel_values"]["messages"]] == ["one", "a", "two", "b"]
    assert saver.get_tuple({"configurable": {"thread_id": "other"}}) is None
    older = saver.get_tuple(history[-1].config)  # any older checkpoint can be read back: the audit trail
    assert older.checkpoint["id"] == history[-1].checkpoint["id"]
    assert len(list(saver.list(config, limit=2))) == 2
    saver.delete_thread("t1")
    assert saver.get_tuple(config) is None


# ----- compaction -----

def compacting(tmp_path: Path, summary_script: list[Any], answers: int, **settings: Any):
    chat = model(*[f"answer {i}" for i in range(answers)])
    summariser = model(*summary_script)
    events: list[dict] = []
    cfg = CompactSettings(0.7, settings.get("ceiling", 1500), settings.get("keep", 1), "claude-haiku-5-5")
    graph = build_graph(chat, BlobTableSaver(DirBackend(tmp_path)), summariser, settings=cfg, events=events)
    return graph, chat, summariser, events


def test_a_summarising_node_trims_the_messages_keeps_the_summary_and_the_recent_turns(tmp_path: Path) -> None:
    graph, chat, summariser, events = compacting(tmp_path, ["They asked about leave."], 5)
    pad = " lorem ipsum" * 200
    for i in range(4):
        out = run(graph, f"question {i}{pad}")
    assert out["summary"] == "They asked about leave." and [e["type"] for e in events] == ["compaction"]
    assert [str(m.content)[:10] for m in out["messages"]] == ["question 2", "answer 2", "question 3", "answer 3"]
    assert any("They asked about leave." in s for s in chat.seen[-1])  # the model got the summary
    old = list(graph.checkpointer.list({"configurable": {"thread_id": "t1"}}))  # the originals are in older checkpoints
    assert any(len(t.checkpoint["channel_values"].get("messages", [])) >= 4 for t in old)


@pytest.mark.parametrize("bad", ["", ("Sorry.", "content_filter"), ("Half a summ", "length"), Fault(529)])
def test_a_bad_summary_leaves_the_history_alone(tmp_path: Path, bad: Any) -> None:
    graph, chat, _, events = compacting(tmp_path, [bad], 4)
    pad = " lorem ipsum" * 200
    for i in range(3):
        out = run(graph, f"question {i}{pad}")
    assert events and events[0]["type"] == "compaction_failed" and not out.get("summary")
    assert len(out["messages"]) == 6
