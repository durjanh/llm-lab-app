"""What every workflow example shares: the Azure OpenAI client, a trace of what happened, and the command line.

Each NN_*.py file here is one workflow type on Microsoft Agent Framework. It has a TITLE and a default TASK, and
either build(lab), which returns a workflow, or run(lab, task), for the types that are more than one workflow run.
The /workflows page runs these same files through backend/app/gateways/agent_workflows.py.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import sys
import time
from collections.abc import Callable
from dataclasses import asdict, is_dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

from agent_framework import Agent, Workflow, chat_middleware
from agent_framework.openai import OpenAIChatCompletionClient
from azure.identity import DefaultAzureCredential
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SHOP = "Pedal & Chain, an invented 40-person online bike shop"


class StopRun(RuntimeError):
    """The run was stopped from outside: the page went away, or it reached its budget."""


def load_dotenv() -> None:
    """The lab's .env, for the command line. The backend passes its own settings instead."""
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def text_of(data: Any) -> str:
    """The readable text in whatever a workflow event carries."""
    if data is None:
        return ""
    if isinstance(data, str):
        return data
    if isinstance(data, list | tuple):
        whole = [d for d in data if type(d).__name__ != "AgentResponseUpdate"]  # streamed pieces repeat the full reply
        if not whole:
            return "".join(d.text or "" for d in data)
        data = whole
        if hasattr(data[-1], "role"):  # a conversation: its last reply
            replies = [m for m in data if str(getattr(m, "role", "")) == "assistant" and m.text]
            return replies[-1].text if replies else ""
        return "\n\n".join(t for t in map(text_of, data) if t)
    if type(data).__name__.endswith("Request"):  # what one step sends the next, not something it said
        return ""
    if hasattr(data, "agent_response"):
        return text_of(data.agent_response)
    if hasattr(data, "text"):
        return data.text or ""
    if isinstance(data, BaseModel):
        return data.model_dump_json(indent=1)
    if is_dataclass(data) and not isinstance(data, type):
        return json.dumps(asdict(data), indent=1, default=str)
    return ""


def graph(workflow: Workflow) -> dict[str, Any]:
    """The workflow's real shape, read from the built object: its executors and its edges, by kind."""
    nodes = [{"id": e.id, "agent": type(e).__name__.endswith("AgentExecutor")} for e in workflow.get_executors_list()]
    edges = []
    for group in workflow.edge_groups:
        kind = type(group).__name__.removesuffix("EdgeGroup").lower()
        if kind != "internal":
            edges += [{"from": e.source_id, "to": e.target_id, "kind": kind} for e in group.edges]
    return {"start": workflow.start_executor_id, "nodes": nodes, "edges": edges}


class Trace:
    """Everything that happened in a run, as plain events, and the tokens it used.

    emit gets each event. ask(id, question) answers a person's question with True or False, and may block.
    stop returns a reason when the run should end; it is checked before each model call.
    """

    def __init__(self, emit: Callable[[dict], None] | None = None, ask: Callable[[str, str], bool] | None = None,
                 stop: Callable[[], str | None] | None = None, on_usage: Callable[[int, int], None] | None = None):
        self.emit, self.ask, self.stop, self.on_usage = emit or (lambda e: None), ask or (lambda i, q: True), stop, on_usage
        self.input_tokens = self.output_tokens = self.calls = 0
        self.started = time.perf_counter()
        self.streaming: dict[str, list[str]] = {}  # output arriving in pieces, by the step producing it

    def event(self, type: str, **fields: Any) -> None:
        self.emit({"type": type, "ms": int((time.perf_counter() - self.started) * 1000), **fields})

    def step(self, node: str, state: str, text: str = "") -> None:
        self.event("step", node=node, state=state, text=text)

    def count(self, usage: Any) -> None:
        """Adds one model reply's tokens."""
        usage = usage or {}
        i, o = int(usage.get("input_token_count") or 0), int(usage.get("output_token_count") or 0)
        self.input_tokens, self.output_tokens, self.calls = self.input_tokens + i, self.output_tokens + o, self.calls + 1
        if self.on_usage:
            self.on_usage(i, o)


class Lab:
    """Builds agents on one Azure OpenAI client (Entra sign-in, no keys), with every model call metered."""

    def __init__(self, trace: Trace, endpoint: str | None = None, model: str | None = None):
        self.trace = trace
        self.model = model or os.environ["AZURE_OPENAI_DEPLOYMENTS"].split(",")[0].strip()
        self.client = OpenAIChatCompletionClient(model=self.model,
                                                 azure_endpoint=endpoint or os.environ["AZURE_OPENAI_ENDPOINT"],
                                                 credential=DefaultAzureCredential(), middleware=[self._meter()])

    def _meter(self) -> Any:
        trace = self.trace

        @chat_middleware
        async def meter(context: Any, call_next: Any) -> None:
            reason = trace.stop() if trace.stop else None
            if reason:
                raise StopRun(reason)
            await call_next()
            if not context.stream:
                trace.count(context.result.usage_details)
                return
            # A streamed reply reports its tokens in one of its last updates; collect them as they pass.
            seen: list[Any] = []

            def watch(update: Any) -> Any:
                seen.extend(c.usage_details for c in update.contents if c.type == "usage")
                return update

            def finish(result: Any) -> Any:
                trace.count(result.usage_details or (seen[-1] if seen else None))
                return result

            context.result.with_transform_hook(watch).with_result_hook(finish)

        return meter

    def agent(self, name: str, instructions: str, **kwargs: Any) -> Agent:
        return Agent(client=self.client, name=name, instructions=instructions, **kwargs)


async def drive(workflow: Workflow, message: Any, trace: Trace, **run_args: Any) -> None:
    """Runs a workflow to the end, reporting each event, and answers any question it stops to ask."""
    responses: dict[str, Any] | None = None
    while True:
        pending: dict[str, Any] = {}
        args = {"responses": responses} if responses else {"message": message} if message is not None else {}
        async for event in workflow.run(stream=True, **args, **run_args):
            if event.type == "request_info":
                pending[event.request_id] = event.data
            else:
                _report(event, trace)
        if not pending:
            return
        run_args = {}  # a resumed checkpoint is only named on the first call
        responses = {}
        for request_id, data in pending.items():
            trace.event("ask", id=request_id, question=text_of(data))
            responses[request_id] = await asyncio.to_thread(trace.ask, request_id, text_of(data))
            trace.event("answered", id=request_id, approved=bool(responses[request_id]))


def _report(event: Any, trace: Trace) -> None:
    if event.type == "executor_invoked":
        trace.step(event.executor_id, "start")
    elif event.type == "executor_completed":
        trace.step(event.executor_id, "done", text_of(event.data))
        if event.executor_id in trace.streaming:
            if text := "".join(trace.streaming.pop(event.executor_id)).strip():
                trace.event("output", node=event.executor_id, text=text)
    elif event.type == "executor_failed":
        trace.step(event.executor_id, "failed", str(getattr(event.details, "message", event.details)))
    elif event.type == "executor_bypassed":
        trace.step(event.executor_id, "skipped")
    elif event.type == "handoff_sent":
        trace.event("route", source=event.data.source, target=event.data.target, how="handoff")
    elif event.type == "group_chat" and type(event.data).__name__ == "GroupChatRequestSentEvent":
        trace.event("route", source="manager", target=event.data.participant_name, how=f"round {event.data.round_index}")
    elif event.type == "magentic_orchestrator":
        trace.event("ledger", kind=str(getattr(event.data.event_type, "value", event.data.event_type)),
                    text=text_of(event.data.content))
    elif event.type == "output" and type(event.data).__name__ == "AgentResponseUpdate":
        trace.streaming.setdefault(event.executor_id, []).append(event.data.text or "")
    elif event.type == "output":
        trace.event("output", node=event.executor_id, text=text_of(event.data))
    elif event.type in ("warning", "error"):
        trace.event("note", text=str(event.data))


def patterns() -> dict[str, ModuleType]:
    """Every workflow example in this folder, by id: 01_sequential.py is "sequential"."""
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    found: dict[str, ModuleType] = {}
    for path in sorted(HERE.glob("[0-9][0-9]_*.py")):
        name = f"wf_{path.stem[3:]}"
        module = sys.modules.get(name)
        if module is None:
            spec = importlib.util.spec_from_file_location(name, path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module  # the framework reads the handlers' type hints through this entry
            spec.loader.exec_module(module)
        found[path.stem[3:]] = module
    return found


async def run_pattern(pattern: str, task: str | None, trace: Trace, endpoint: str | None = None,
                      model: str | None = None) -> None:
    """Runs one workflow type and reports it through the trace."""
    module = patterns()[pattern]
    lab = Lab(trace, endpoint, model)
    task = task or module.TASK
    trace.event("task", pattern=pattern, title=module.TITLE, task=task, model=lab.model)
    if hasattr(module, "run"):
        await module.run(lab, task)
    else:
        workflow = module.build(lab)
        trace.event("graph", **graph(workflow))
        await drive(workflow, task, trace)
    trace.event("usage", input_tokens=trace.input_tokens, output_tokens=trace.output_tokens, calls=trace.calls)


def _print(event: dict) -> None:
    t, stamp = event["type"], f"{event['ms'] / 1000:6.1f}s"
    if t == "step" and event["state"] != "start" and event["text"]:
        print(f"{stamp}  {event['node']}: {event['text']}\n")
    elif t == "step" and event["state"] in ("failed", "skipped"):
        print(f"{stamp}  {event['node']}: {event['state']}")
    elif t == "route":
        print(f"{stamp}  {event['source']} -> {event['target']} ({event['how']})")
    elif t == "ledger":
        print(f"{stamp}  [{event['kind']}] {event['text']}\n")
    elif t == "output":
        print(f"{stamp}  OUTPUT\n{event['text']}\n")
    elif t == "note":
        print(f"{stamp}  note: {event['text']}")
    elif t == "usage":
        print(f"{stamp}  {event['calls']} model calls, {event['input_tokens']} tokens in, {event['output_tokens']} out")


def main(file: str) -> None:
    """The command line for one example: python 02_concurrent.py [--task "..."] [--yes] [--diagram]."""
    module = patterns()[Path(file).stem[3:]]
    parser = argparse.ArgumentParser(description=module.__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--task", help="what to work on, instead of the example's own task")
    parser.add_argument("--yes", action="store_true", help="answer yes to anything the workflow asks a person")
    parser.add_argument("--diagram", action="store_true", help="print the workflow as a Mermaid diagram and stop")
    parser.add_argument("--jsonl", action="store_true", help="print events as @@-prefixed JSON, for the backend to read")
    parser.add_argument("--endpoint", help="the Azure OpenAI endpoint, instead of the one in .env")
    parser.add_argument("--model", help="the deployment, instead of the first in .env")
    args = parser.parse_args()
    load_dotenv()

    def ask(_: str, question: str) -> bool:
        print(f"\nThe workflow is waiting for a person:\n{question}")
        return args.yes or input("Approve? [y/N] ").strip().lower() == "y"

    def line(event: dict) -> None:
        print("@@" + json.dumps(event, default=str), flush=True)  # the .NET runtime prints its own lines to stdout too

    trace = Trace(emit=line, ask=lambda *_: False, on_usage=lambda i, o: line({"type": "tokens", "input": i, "output": o})) \
        if args.jsonl else Trace(emit=_print, ask=ask)
    if args.diagram:
        from agent_framework import WorkflowViz

        print(WorkflowViz(module.build(Lab(trace))).to_mermaid())
        return
    asyncio.run(run_pattern(Path(file).stem[3:], args.task, trace, args.endpoint, args.model))
