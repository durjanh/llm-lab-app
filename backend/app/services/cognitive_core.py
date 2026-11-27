"""The cognitive core: can a small model that reasons and looks things up stand in for a big one that remembers?

The idea (Andrej Karpathy's "cognitive core"): strip most of the knowledge out of a model and keep the part that
thinks, reasons and uses tools, about a billion parameters, with the knowledge outside it in search, memory and tools.
This runs the experiment. Each question is answered three ways by each of two models, side by side:

- closed book: only what the weights hold;
- retrieval done for it: code searches the reference library with the question and puts the best entries in the
  prompt (classic RAG), with a calculator;
- its own tools: the model decides what to search for and when, and uses the calculator, told that its own memory is
  not trusted (agentic RAG).

The two models are a small "core" (LLM_LAB_CORE_MODEL, about 1B parameters) and a big one (the lab's default, or one
the person picks). Separating the last two shows which skill a small model lacks: deciding to look things up, or
reasoning over what was found.

The library is mostly about an invented island, so no model can know those facts from training, plus a few real-world
facts. The questions separate knowledge from reasoning: invented facts, real-world facts, two facts and some
arithmetic, and a puzzle with nothing to look up. Code marks every answer; no model grades another.
"""
from __future__ import annotations

import contextvars
import json
import math
import re
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from ..core.errors import ApiError, describe, to_api_error
from ..gateways.claude import ClaudeGateway
from ..gateways.core_model import Core, CoreModelUnavailable
from ..shared import DEFAULT_MODEL, PRICES, text_of
from .planning_patterns import calculate
from .runs import Run, RunStreamer
from .spend import SpendTracker

SETUPS = ["core_closed", "core_rag", "core_tools", "big_closed", "big_rag", "big_tools"]
SETUP_NAMES = {"core_closed": "Small core, closed book", "core_rag": "Small core, retrieval done for it",
               "core_tools": "Small core, its own tools", "big_closed": "Big model, closed book",
               "big_rag": "Big model, retrieval done for it", "big_tools": "Big model, its own tools"}
MAX_STEPS = 6  # model calls per setup per question
MAX_TOKENS = 600
MAX_QUESTIONS = 10
WORST_INPUT_TOKENS = 4000  # the longest prompt a call here sends (tools, entries, results), for the budget

# ---------- the reference library: what "the internet" is in this experiment ----------

LIBRARY: list[dict[str, str]] = [
    {"title": "Isle of Tarrow",
     "text": "The Isle of Tarrow is an island off the west coast with two towns, Kestle and Porth Vane. Its economy "
             "rests on fishing, sheep and summer visitors."},
    {"title": "Kestle",
     "text": "Kestle is the largest town on the Isle of Tarrow, with a population of 4,860 at the last count. The "
             "ferry to the mainland leaves from Kestle harbour."},
    {"title": "Porth Vane",
     "text": "Porth Vane is the second town of the Isle of Tarrow, on the north shore, with a population of 1,140."},
    {"title": "Tollan Bridge",
     "text": "The Tollan Bridge, a stone road bridge over the River Tollan on the Isle of Tarrow, opened in 1912. It "
             "replaced a ford that flooded each winter."},
    {"title": "Old Mill Bridge",
     "text": "The Old Mill Bridge in Porth Vane is a footbridge built in 1868 and rebuilt after a storm in 1953."},
    {"title": "Gull Point lighthouse",
     "text": "The lighthouse at Gull Point, on the Isle of Tarrow, was designed by the engineer Edith Marlowe. Its "
             "light first shone in 1931. The tower is 38 metres tall."},
    {"title": "Edith Marlowe",
     "text": "Edith Marlowe (1889 to 1964) was a civil engineer who designed harbour walls and lighthouses, among them "
             "the Gull Point lighthouse."},
    {"title": "Tarrow ferry",
     "text": "The Tarrow ferry runs between Kestle and the mainland. Each crossing takes 42 minutes and carries up to "
             "240 passengers."},
    {"title": "Tarrow sheep",
     "text": "The Tarrow sheep is a small hardy breed kept on the island's hills; about 9,000 graze there."},
    {"title": "Tungsten",
     "text": "Tungsten is a chemical element with the symbol W and atomic number 74. It has the highest melting point "
             "of all metals."},
    {"title": "Peace of Westphalia",
     "text": "The Peace of Westphalia, a set of treaties signed in 1648, ended the Thirty Years' War."},
    {"title": "Ethanol",
     "text": "Ethanol boils at 78.37 degrees Celsius at standard sea-level pressure."},
]

# ---------- the questions ----------


def _number(expected: float, tolerance: float = 0.0) -> Callable[[str], bool]:
    def check(answer: str) -> bool:
        return any(abs(n - expected) <= tolerance for n in numbers_in(answer))
    return check


def _words(*accepted: str) -> Callable[[str], bool]:
    def check(answer: str) -> bool:
        text = answer.lower()
        return any(a.lower() in text for a in accepted)
    return check


def _named(expected: str, names: tuple[str, ...], role: str) -> Callable[[str], bool]:
    """Right when the answer gives `expected` as the `role` ("second youngest"): "Cara is the second youngest" or "the
    second youngest is Cara". Without that phrase, the last of `names` it mentions, because an answer that restates
    the puzzle ("Ana, Ben, Cara, Dev, so it is Ben") names them all and its conclusion comes last."""
    alternatives = "|".join(names)
    def check(answer: str) -> bool:
        said = (re.search(rf"\b({alternatives})\s+(?:is|would be)\s+(?:the\s+)?{role}\b", answer, re.I)
                or re.search(rf"\b{role}\b\W+(?:is\W+|would be\W+)?({alternatives})\b", answer, re.I))
        if said:
            return said.group(1).lower() == expected
        found = [(m.start(), m.group(0).lower()) for m in re.finditer(rf"\b({alternatives})\b", answer, re.I)]
        return bool(found) and max(found)[1] == expected
    return check


QUESTIONS: list[dict[str, Any]] = [
    {"id": "bridge-year", "kind": "Invented fact", "text": "In what year did the Tollan Bridge on the Isle of Tarrow "
     "open?", "expected": "1912", "check": _number(1912)},
    {"id": "lighthouse-designer", "kind": "Invented fact", "text": "Who designed the lighthouse at Gull Point on the "
     "Isle of Tarrow?", "expected": "Edith Marlowe", "check": _words("marlowe")},
    {"id": "kestle-population", "kind": "Invented fact", "text": "What is the population of Kestle, the largest town "
     "on the Isle of Tarrow?", "expected": "4,860", "check": _number(4860)},
    {"id": "tungsten", "kind": "Real-world fact", "text": "What is the atomic number of tungsten?", "expected": "74",
     "check": _number(74)},
    {"id": "westphalia", "kind": "Real-world fact", "text": "In what year was the Peace of Westphalia signed?",
     "expected": "1648", "check": _number(1648)},
    {"id": "ethanol", "kind": "Real-world fact", "text": "At what temperature, in degrees Celsius, does ethanol boil "
     "at sea-level pressure?", "expected": "78.37", "check": _number(78.37, 0.5)},
    {"id": "years-between", "kind": "Two facts and arithmetic", "text": "How many years after the Tollan Bridge "
     "opened did the Gull Point lighthouse first shine?", "expected": "19 (1931 - 1912)", "check": _number(19)},
    {"id": "ferry-crossings", "kind": "Two facts and arithmetic", "text": "If every resident of Kestle and of Porth "
     "Vane crossed to the mainland once on the Tarrow ferry, with every crossing full, how many crossings would that "
     "take?", "expected": "25 ((4,860 + 1,140) / 240)", "check": _number(25)},
    {"id": "lighthouse-feet", "kind": "Two facts and arithmetic", "text": "How tall is the Gull Point lighthouse in "
     "feet, to the nearest foot? (One metre is 3.28084 feet.)", "expected": "125 (38 x 3.28084 = 124.7)",
     "check": _number(125, 0.6)},
    {"id": "ages", "kind": "Reasoning only", "text": "Ana is older than Ben. Ben is older than Cara. Cara is older "
     "than Dev. Who is the second youngest? Answer with the name.", "expected": "Cara", "check": _named("cara", ("ana", "ben", "cara", "dev"), "second youngest")},
]
QUESTIONS_BY_ID = {q["id"]: q for q in QUESTIONS}


def numbers_in(text: str) -> list[float]:
    """Every number in an answer, with thousands separators removed: "4,860" and "78.37" count."""
    return [float(n.replace(",", "")) for n in re.findall(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?", text)]


# ---------- the tools ----------

TOOLS: list[dict[str, Any]] = [
    {"name": "search_library", "description": "Searches the reference library and returns the best matching "
                                              "entries. Use it for every fact.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string", "description": "What to look up"}},
                      "required": ["query"]}},
    {"name": "calculator", "description": "Evaluates arithmetic: + - * / ( ) and round(x, n). Use it for every sum.",
     "input_schema": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}},
]

STOP = {"the", "a", "an", "of", "on", "in", "at", "to", "is", "was", "did", "what", "who", "how", "and", "for", "by",
        "it", "its", "with", "from", "that", "this", "which", "when", "year", "many", "much"}


def _terms(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOP]


_DOC_TERMS = [set(_terms(d["title"] + " " + d["text"])) for d in LIBRARY]
_IDF = {t: math.log(1 + len(LIBRARY) / sum(1 for terms in _DOC_TERMS if t in terms))
        for terms in _DOC_TERMS for t in terms}


def search(query: str, limit: int = 3) -> list[dict[str, str]]:
    """Keyword search, each matching term weighted by how rare it is (a small BM25): enough to show retrieval
    without a database. Ties keep the library's order, so the same query always gives the same results."""
    terms = set(_terms(query))
    scored = sorted(((sum(_IDF.get(t, 0.0) for t in terms & doc), -i) for i, doc in enumerate(_DOC_TERMS)),
                    reverse=True)
    return [LIBRARY[-i] for score, i in scored[:limit] if score > 0]


def run_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "search_library":
        query = str(args.get("query", ""))[:200]
        results = search(query)
        return {"results": results} if results else {"results": [], "note": "Nothing matched. Try other words."}
    if name == "calculator":
        try:
            return {"result": calculate(str(args.get("expression", "")))}
        except (ValueError, SyntaxError, ZeroDivisionError, TypeError) as exc:
            return {"error": f"Could not calculate: {exc}"}
    return {"error": f"There is no tool called {name}."}


# ---------- the system prompts: the setups differ only in these and in the tools ----------

CLOSED = ("Answer the question from what you know. Be brief: give the answer first, in one sentence. If you do not "
          "know, say so.")
# Measured on the lab's two Qwen models: "you know nothing, search first ... or say you do not know" made both answer
# "I do not know" without searching; this wording made the 9B search every time (the 0.8B still did not).
# Facts are what is restricted, not thinking: a first version said "if the library does not have it, say you do not
# know", and both models refused the logic puzzle, which needs no facts at all.
WITH_TOOLS = ("Always call search_library before you answer a question that needs a fact, even when you think you "
              "know: your own memory of facts is not trusted. Search for each fact the question needs, use calculator "
              "for any sum, then answer in one sentence from what the tools returned. A question that needs only "
              "reasoning needs no search.")
GIVEN = ("Take every fact from the library entries below, which were found for this question; your own memory of "
         "facts is not trusted. Use calculator for any sum. Reasoning needs no entry. If a fact you need is not in "
         "the entries, say you do not know. Answer in one sentence.")
CALCULATOR = [t for t in TOOLS if t["name"] == "calculator"]


class Stop(Exception):
    """The setup reached its step cap, the run's budget, or the page went away."""


def worst_cost(model: str) -> float:
    """The most one call to `model` can cost here: the longest prompt and a full reply. Nothing for a model with no
    price (one on this machine)."""
    price = PRICES.get(model)
    return (WORST_INPUT_TOKENS * price["input"] + MAX_TOKENS * price["output"]) / 1_000_000 if price else 0.0


class Budget:
    """A run's cap, shared by setups that call at the same moment. Each paid call reserves its worst case first, so
    three calls starting together cannot each see room that only one of them has."""

    def __init__(self, cap: float):
        self.cap, self.spent, self.held = cap, 0.0, 0.0
        self._lock = threading.Lock()

    def reserve(self, amount: float) -> bool:
        with self._lock:
            if self.spent + self.held + amount > self.cap or self.spent >= self.cap:
                return False
            self.held += amount
            return True

    def settle(self, reserved: float, cost: float) -> None:
        with self._lock:
            self.held -= reserved
            self.spent += cost


class Attempt:
    """One setup answering one question: its model calls, tool calls and what it cost."""

    def __init__(self, svc: "CognitiveCoreService", setup: str, question: dict[str, Any], big_model: str, run: Run,
                 budget: Budget):
        self.svc, self.setup, self.question, self.run, self.budget = svc, setup, question, run, budget
        self.core = setup.startswith("core")
        self.model = svc.core.model if self.core else big_model
        self.calls = self.tool_calls = self.input_tokens = self.output_tokens = 0
        self.cost = 0.0

    def emit(self, kind: str, **fields: Any) -> None:
        self.run.publish({"type": "step", "question": self.question["id"], "setup": self.setup, "kind": kind, **fields})

    def call(self, system: str, messages: list[dict], tools: list[dict] | None) -> Any:
        if self.run.cancelled.is_set():
            raise Stop("The page went away.")
        if self.calls >= MAX_STEPS:
            raise Stop(f"Stopped at the step cap ({MAX_STEPS} model calls).")
        held = 0.0 if self.core else worst_cost(self.model)
        if not self.budget.reserve(held):
            raise Stop(f"Stopped: the next call could pass the run's budget (${self.budget.cap:.2f}).")
        params: dict[str, Any] = {"max_tokens": MAX_TOKENS, "system": system, "messages": messages}
        if tools:
            params["tools"] = tools
        cost = 0.0
        try:
            if self.core:
                response = self.svc.core.create(**params)  # on this machine: nothing to charge
            else:
                response = self.svc.claude.create(model=self.model, **params)
                cost = self.svc.spend.charge(response, self.model) or 0.0
        except CoreModelUnavailable:
            raise
        except Exception as exc:
            raise to_api_error(exc) from exc
        finally:
            self.budget.settle(held, cost)
        self.calls += 1
        self.cost += cost
        usage = getattr(response, "usage", None)
        self.input_tokens += sum(getattr(usage, k, 0) or 0 for k in  # a cached prompt still went in
                                 ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
        self.output_tokens += getattr(usage, "output_tokens", 0) or 0
        self.emit("call", calls=self.calls, cost_usd=round(self.cost, 6))
        return response

    def answer(self) -> str:
        mode = self.setup.split("_", 1)[1]
        question = self.question["text"]
        if mode == "rag":  # the harness searches, once, with the question itself
            found = search(question)
            self.emit("retrieved", titles=[d["title"] for d in found])
            library = "\n".join(f"- {d['title']}: {d['text']}" for d in found) or "(nothing matched)"
            question = f"Library entries:\n{library}\n\nQuestion: {question}"
        system = {"closed": CLOSED, "rag": GIVEN, "tools": WITH_TOOLS}[mode]
        tools = {"closed": None, "rag": CALCULATOR, "tools": TOOLS}[mode]
        messages: list[dict] = [{"role": "user", "content": question}]
        while True:
            response = self.call(system, messages, tools)
            stop = getattr(response, "stop_reason", None)
            if stop == "refusal":
                raise Stop("The model refused to answer.")
            if stop == "max_tokens":
                raise Stop(f"Cut off at the token limit ({MAX_TOKENS}) before it finished.")
            uses = [b for b in response.content if getattr(b, "type", "") == "tool_use"]
            if not uses:
                answer = text_of(response).strip()
                if not answer:
                    raise Stop("The model gave no answer.")
                return answer
            messages.append({"role": "assistant", "content": [b.model_dump() for b in response.content]})
            results = []
            for use in uses:
                args = use.input
                self.tool_calls += 1
                self.emit("tool", tool=use.name, input=args)
                # A small local model can send a tool call whose input is not an object: say so, as a tool would.
                result = run_tool(use.name, args) if isinstance(args, dict) else {
                    "error": "The tool's input must be an object of named arguments."}
                self.emit("observation", tool=use.name, result=result)
                results.append({"type": "tool_result", "tool_use_id": use.id, "content": json.dumps(result)})
            messages.append({"role": "user", "content": results})


class CognitiveCoreService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, core: Core, streamer: RunStreamer | None = None,
                 parallel: bool = True):
        self.claude, self.spend, self.core, self.streamer, self.parallel = claude, spend, core, streamer, parallel
        # One run at a time: a double click or a second tab would stack its calls on the same local server.
        self._busy = threading.Lock()
        self.start_within_s = 30.0  # a run whose work has not started by then (the page went first) lets go of it

    def info(self) -> dict[str, Any]:
        return {"core_model": self.core.model, "default_big_model": DEFAULT_MODEL,
                "setups": [{"id": s, "name": SETUP_NAMES[s]} for s in SETUPS],
                "questions": [{k: q[k] for k in ("id", "kind", "text", "expected")} for q in QUESTIONS],
                "library": LIBRARY, "tools": [{"name": t["name"], "description": t["description"]} for t in TOOLS],
                "prompts": {"closed": CLOSED, "rag": GIVEN, "tools": WITH_TOOLS}, "max_steps": MAX_STEPS}

    def _one(self, setup: str, question: dict[str, Any], big_model: str, run: Run, budget: Budget) -> dict[str, Any]:
        a = Attempt(self, setup, question, big_model, run, budget)
        started = time.perf_counter()
        answer, stopped = "", None
        try:
            answer = a.answer()
        except (Stop, CoreModelUnavailable) as exc:
            stopped = str(exc)
        except ApiError as exc:
            stopped = exc.message
        except Exception as exc:  # one setup's failure must not end the others
            stopped = describe(exc)
        correct = bool(answer) and bool(question["check"](answer))
        result = {"type": "answer", "question": question["id"], "setup": setup, "model": a.model, "answer": answer,
                  "correct": correct, "stopped": stopped, "model_calls": a.calls, "tool_calls": a.tool_calls,
                  "input_tokens": a.input_tokens, "output_tokens": a.output_tokens,
                  "seconds": round(time.perf_counter() - started, 2), "cost_usd": round(a.cost, 6)}
        run.publish(result)
        return result

    def run(self, question_ids: list[str], setups: list[str], big_model: str | None, budget_usd: float) -> Iterator[str]:
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        unknown = [q for q in question_ids if q not in QUESTIONS_BY_ID]
        if unknown or not question_ids or len(question_ids) > MAX_QUESTIONS:
            raise ApiError(400, "invalid_request", "Choose questions from the list.")
        chosen = [s for s in SETUPS if s in setups]
        if not chosen:
            raise ApiError(400, "invalid_request", "Choose at least one setup.")
        if not self.core.model and any(s.startswith("core") for s in chosen):
            raise ApiError(409, "no_core_model", "No core model is set. Set LLM_LAB_CORE_MODEL and run "
                                                 "./tools/local-model.sh --core.")
        big = big_model or DEFAULT_MODEL
        questions = [QUESTIONS_BY_ID[q] for q in dict.fromkeys(question_ids)]
        if not self._busy.acquire(blocking=False):
            raise ApiError(409, "busy", "A run is already going. Wait for it, or stop it first.")
        run, budget = Run(), Budget(budget_usd)
        # The lock is let go exactly once: by the work when it ends, or, when the page went before the work began, by
        # whichever notices first. A generator closed before it started never runs its own `finally`, so a timer
        # covers that case.
        guard = threading.Lock()
        state = {"started": False, "abandoned": False}

        def abandon() -> None:
            with guard:
                if not state["started"] and not state["abandoned"]:
                    state["abandoned"] = True
                    self._busy.release()

        timer = threading.Timer(self.start_within_s, abandon)
        timer.daemon = True
        timer.start()

        def work() -> None:
            with guard:
                if state["abandoned"]:
                    return
                state["started"] = True
            timer.cancel()
            try:
                self._work(run, budget, questions, chosen, big)
            finally:
                self._busy.release()

        def stream() -> Iterator[str]:
            try:
                yield from self.streamer.lines(run, work)  # type: ignore[union-attr]
            finally:
                abandon()

        return stream()

    def _work(self, run: Run, budget: "Budget", questions: list[dict[str, Any]], chosen: list[str], big: str) -> None:
        """Each question in turn, its setups side by side, then the totals."""
        run.publish({"type": "started", "questions": [q["id"] for q in questions], "setups": chosen,
                     "core_model": self.core.model, "big_model": big, "budget_usd": budget.cap})
        results: list[dict[str, Any]] = []
        for question in questions:
            if run.cancelled.is_set():
                break
            if self.parallel and len(chosen) > 1:
                with ThreadPoolExecutor(max_workers=len(chosen)) as pool:
                    futures = [pool.submit(contextvars.copy_context().run, self._one, s, question, big, run, budget)
                               for s in chosen]
                    results += [f.result() for f in futures]
            else:
                results += [self._one(s, question, big, run, budget) for s in chosen]
        run.publish({"type": "done", "spent_usd": round(budget.spent, 6), "summary": summarise(results, chosen)})


def summarise(results: list[dict[str, Any]], setups: list[str]) -> list[dict[str, Any]]:
    """Per setup: how many it got right, and what that took."""
    out = []
    for s in setups:
        mine = [r for r in results if r["setup"] == s]
        out.append({"setup": s, "answered": len(mine), "correct": sum(r["correct"] for r in mine),
                    "tool_calls": sum(r["tool_calls"] for r in mine),
                    "tokens": sum(r["input_tokens"] + r["output_tokens"] for r in mine),
                    "seconds": round(sum(r["seconds"] for r in mine), 2),
                    "cost_usd": round(sum(r["cost_usd"] for r in mine), 6)})
    return out
