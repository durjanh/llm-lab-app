"""Model failover in LangGraph: a model with fallbacks, a retry policy on the node, a checkpointer in Blob + Table and a
summarising node, all with the rules the /model-failover page uses (shared/rules.py).

  guarded(model)        classifies a failure like the lab's router. A short 429 is retried once here; a long 429, a 529,
                        a 5xx, a timeout or an open breaker raises Switch; a 400/401/403/404 is raised as it is.
  .with_fallbacks()     the primary guarded model, then the fallbacks, with exceptions_to_handle=(Switch,): only a
                        Switch moves to the next model, so a bad request is never hidden by a fallback.
  RetryPolicy           on the agent node, retry_on=Switch: if every model failed, the node tries once more after a pause
                        (a breaker may have half-opened), and a crash resumes from the last checkpoint.
  BlobTableSaver        checkpoints in Blob, indexed in a Table (blob_saver.py): the conversation is in your store.
  compact node          before the model: over the threshold, the older turns are summarised and removed from the state's
                        messages, the summary kept in state["summary"]. The older checkpoints still hold the originals.
"""
from __future__ import annotations

import sys
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Annotated, Any

from langchain_core.messages import AIMessage, AnyMessage, BaseMessage, HumanMessage, RemoveMessage, SystemMessage
from langchain_core.runnables import Runnable, RunnableLambda
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import RetryPolicy
from typing_extensions import TypedDict

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "shared"))
from rules import CircuitBreaker, CompactSettings, classify, compaction_cut, estimate_tokens, usable_summary  # noqa: E402


class Switch(Exception):
    """This model cannot answer now (overloaded, rate limited for long, timed out, breaker open): try the next one."""


class State(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    summary: str
    answered_by: str


def guarded(model: Any, name: str, breaker: CircuitBreaker, faults: list[Exception] | None = None,
            sleep: Callable[[float], None] = time.sleep, events: list[dict] | None = None) -> Runnable:
    """The model as a runnable that raises Switch for what another model might not suffer. `faults` are injected failures,
    raised before the model is called (free)."""
    log = events if events is not None else []

    def call(messages: Any) -> Any:
        if not breaker.allow():
            log.append({"type": "skip", "model": name, "reason": f"breaker {breaker.state}"})
            raise Switch(f"{name}: breaker {breaker.state}")
        retried = False
        while True:
            try:
                if faults:
                    raise faults.pop(0)
                reply = model.invoke(messages)
            except Exception as exc:  # noqa: BLE001
                verdict = classify(exc)
                if verdict.action == "fail":
                    breaker.release()
                    raise
                if verdict.action == "retry" and not retried:
                    retried = True
                    log.append({"type": "retry", "model": name, "reason": verdict.reason})
                    sleep(verdict.retry_after or 0)
                    continue
                breaker.failure(verdict.retry_after)
                log.append({"type": "switch", "from": name, "reason": verdict.reason})
                raise Switch(f"{name}: {verdict.reason}") from exc
            breaker.success()
            reply.additional_kwargs["answered_by"] = name
            return reply

    return RunnableLambda(call, name=name)


def failover_model(models: Sequence[tuple[str, Any]], cooldown_s: float = 30.0, clock: Callable[[], float] = time.monotonic,
                   sleep: Callable[[float], None] = time.sleep, events: list[dict] | None = None,
                   faults: dict[str, list[Exception]] | None = None) -> Runnable:
    """`models` is [(name, chat model), ...] in the order to try them."""
    faults = faults if faults is not None else {}
    chain = [guarded(m, n, CircuitBreaker(cooldown_s, clock), faults.setdefault(n, []), sleep, events) for n, m in models]
    return chain[0].with_fallbacks(chain[1:], exceptions_to_handle=(Switch,))


def text_of(messages: Sequence[BaseMessage]) -> str:
    return "\n".join(f"{m.type}: {m.content}" for m in messages)


def build_graph(model: Runnable, checkpointer: Any, summariser: Runnable | None = None, window: int = 200_000,
                settings: CompactSettings | None = None, events: list[dict] | None = None,
                retry: RetryPolicy | None = None) -> Any:
    cfg = settings or CompactSettings.from_env()
    log = events if events is not None else []

    def compact(state: State) -> dict[str, Any]:
        messages = state["messages"]
        if summariser is None or estimate_tokens(text_of(messages)) <= cfg.threshold(window):
            return {}
        turns, n = [], -1
        for m in messages:
            n += isinstance(m, HumanMessage)  # a turn starts at each human message: the cut is never inside a tool exchange
            turns.append(n)
        cut = compaction_cut(turns, cfg.keep_recent)
        if not cut:
            return {}
        covered = messages[:cut]
        transcript = (f"{state['summary']}\n" if state.get("summary") else "") + text_of(covered)
        try:
            reply = summariser.invoke([SystemMessage("Summarise this conversation in under 200 words: questions, answers, "
                                                     "decisions, anything open. Plain text."), HumanMessage(transcript)])
        except Exception as exc:  # noqa: BLE001  (no summary: the full history is sent)
            log.append({"type": "compaction_failed", "reason": type(exc).__name__})
            return {}
        finish = (getattr(reply, "response_metadata", {}) or {}).get("stop_reason") or (getattr(reply, "response_metadata", {}) or {}).get("finish_reason")
        if not usable_summary(str(reply.content), finish):
            log.append({"type": "compaction_failed", "reason": f"empty, refused or cut off ({finish})"})
            return {}
        log.append({"type": "compaction", "covers": [covered[0].id, covered[-1].id]})
        return {"summary": str(reply.content).strip(), "messages": [RemoveMessage(id=m.id) for m in covered]}

    def agent(state: State) -> dict[str, Any]:
        messages = list(state["messages"])
        if state.get("summary"):
            messages = [SystemMessage(f"Summary of the earlier conversation:\n{state['summary']}"), *messages]
        reply: AIMessage = model.invoke(messages)
        return {"messages": [reply], "answered_by": reply.additional_kwargs.get("answered_by", "")}

    graph = StateGraph(State)
    graph.add_node("compact", compact)
    graph.add_node("agent", agent, retry_policy=retry or RetryPolicy(max_attempts=2, initial_interval=1.0, retry_on=Switch))
    graph.add_edge(START, "compact")
    graph.add_edge("compact", "agent")
    graph.add_edge("agent", END)
    return graph.compile(checkpointer=checkpointer)
