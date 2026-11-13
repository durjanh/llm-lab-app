"""Structured extraction (Claude Certified Architect, scenario 6): invoices, till receipts and purchase orders turned
into validated records for a downstream system. Each mechanism the exam asks about runs here on an invented, labelled
document set: extraction as a tool with a schema, tool_choice, validation with retry, few-shot examples, the Message
Batches API, confidence-based human review, and an A/B comparison of two models."""
from __future__ import annotations

import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import PRICES, cost_usd
from .extraction_docs import BY_ID, DOCUMENTS, EXAMPLES, FIELDS
from .extraction_logic import (BASE_SYSTEM, CURRENCIES, PLACEHOLDERS, TOOLS, analyse, build_prompt, chunk_custom_id, chunk_document,
                               compare_runs, corrupt, extraction_schema, issue_keys, match_results, merge_chunks,
                               resubmit_plan, retry_decision, retry_messages, score, split_custom_id, summarise,
                               system_prompt, tool_input, validate)
from .runs import Run, RunStreamer
from .spend import SpendTracker

BATCH_DISCOUNT = 0.5
FIRST_PASS_TOKENS = 700  # small on purpose: the 30-line order does not fit, so the batch demo has something to resubmit
FULL_TOKENS = 1500
WORKERS = 4
KEPT_RUNS = 16
MAX_RETRIES = 2
LOOSE_SYSTEM = "You help the accounts team with documents that arrive in the post room."
TOOL_CHOICE_FORCED = {"type": "tool", "name": "extract_metadata"}


def raw(response: Any) -> dict[str, Any]:
    """A response as the page shows it: stop reason, content blocks, usage. Nothing tidied."""
    blocks = []
    for b in response.content:
        if b.type == "text":
            blocks.append({"type": "text", "text": b.text})
        elif b.type == "tool_use":
            blocks.append({"type": "tool_use", "name": b.name, "input": b.input})
        else:
            blocks.append({"type": b.type})
    return {"stop_reason": response.stop_reason, "content": blocks,
            "usage": {"input_tokens": response.usage.input_tokens, "output_tokens": response.usage.output_tokens}}


def judge_missing(value: Any, truth: Any) -> str:
    """For a field the document leaves out: did the model say null, write a placeholder, or invent a value?"""
    if truth is not None:
        return "correct" if value == truth else "wrong"
    if value is None:
        return "null"
    if isinstance(value, str) and value.strip().lower() in PLACEHOLDERS:
        return "placeholder"
    return "invented"


class ExtractionService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, streamer: RunStreamer | None = None):
        self.claude, self.spend, self.streamer = claude, spend, streamer
        self._runs: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._batches: dict[str, dict[str, Any]] = {}
        self._groups: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    # ----- the plumbing -----

    def _call(self, model: str, max_tokens: int, system: str, messages: list[dict[str, Any]], tools: list[str],
              tool_choice: dict[str, Any]) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            response = self.claude.create(model=model, max_tokens=max_tokens, system=system, messages=messages,
                                          tools=[TOOLS[t] for t in tools], tool_choice=tool_choice)
        except Exception as exc:
            raise to_api_error(exc) from exc
        return {"response": response, "latency_s": round(time.perf_counter() - started, 3),
                "cost_usd": self.spend.charge(response, model) or 0.0}

    def _doc(self, doc_id: str) -> dict[str, Any]:
        if doc_id not in BY_ID:
            raise ApiError(404, "not_found", f"No document {doc_id}.")
        return BY_ID[doc_id]

    def _extract(self, doc: dict[str, Any], model: str, few_shot: bool, max_tokens: int = FULL_TOKENS) -> dict[str, Any]:
        """One document through the main pipeline: the forced extraction tool, then the semantic checks and the scoring."""
        try:
            r = self._call(model, max_tokens, system_prompt(few_shot), [{"role": "user", "content": build_prompt(doc["text"])}],
                           ["extract_document"], {"type": "tool", "name": "extract_document"})
            ex, stop, latency, cost = tool_input(r["response"]), r["response"].stop_reason, r["latency_s"], r["cost_usd"]
            error = None if ex else f"No tool call (stop reason {stop})."
        except ApiError as exc:
            ex, stop, latency, cost, error = None, "error", 0.0, 0.0, exc.message
        return self._record(doc, ex, stop, latency, cost, error)

    @staticmethod
    def _record(doc: dict[str, Any], ex: dict[str, Any] | None, stop: str, latency: float | None, cost: float,
                error: str | None = None) -> dict[str, Any]:
        return {"doc_id": doc["id"], "type": doc["type"], "split": doc["split"], "extraction": ex,
                "issues": validate(ex, doc["type"]) if ex else [], "stop_reason": stop, "latency_s": latency,
                "cost_usd": round(cost, 6), "error": error, **score(doc, ex)}

    # ----- information -----

    def info(self) -> dict[str, Any]:
        return {"documents": [{k: d[k] for k in ("id", "type", "split", "layout", "text", "truth", "conflict",
                                                  "needs_contract", "note")} for d in DOCUMENTS],
                "fields": FIELDS, "examples": EXAMPLES,
                "schemas": {"nullable": extraction_schema(), "required": extraction_schema(nullable=False)},
                "tools": {k: {"name": v["name"], "description": v["description"]} for k, v in TOOLS.items()},
                "system": BASE_SYSTEM, "currencies": CURRENCIES, "first_pass_tokens": FIRST_PASS_TOKENS,
                "batch_discount": BATCH_DISCOUNT,
                "prices": {m: p for m, p in PRICES.items() if m.startswith("claude-")}}

    def estimate(self, model: str, few_shot: bool, doc_ids: list[str] | None) -> dict[str, Any]:
        docs = [BY_ID[i] for i in doc_ids] if doc_ids else DOCUMENTS
        price = PRICES[model]
        prompt_tokens = (len(system_prompt(few_shot)) + sum(len(d["text"]) for d in docs) / max(len(docs), 1)
                         + len(str(TOOLS["extract_document"]))) / 3.5
        cost = len(docs) * (prompt_tokens * price["input"] + 420 * price["output"]) / 1e6
        return {"docs": len(docs), "approx_cost_usd": round(cost, 4), "approx_cost_batch_usd": round(cost * BATCH_DISCOUNT, 4)}

    # ----- 1. the schema: required and non-nullable invents values -----

    def schema_demo(self, doc_id: str, model: str) -> dict[str, Any]:
        doc = self._doc(doc_id)
        out: dict[str, Any] = {"doc_id": doc_id, "model": model, "cost_usd": 0.0, "variants": {}}
        for variant, nullable in (("required", False), ("nullable", True)):
            tool = {"name": "extract_document", "description": TOOLS["extract_document"]["description"],
                    "input_schema": extraction_schema(nullable=nullable)}
            started = time.perf_counter()
            try:
                response = self.claude.create(model=model, max_tokens=FULL_TOKENS, system=BASE_SYSTEM.split("\n\nRules:")[0],
                                              messages=[{"role": "user", "content": build_prompt(doc["text"])}],
                                              tools=[tool], tool_choice={"type": "tool", "name": "extract_document"})
            except Exception as exc:
                raise to_api_error(exc) from exc
            cost = self.spend.charge(response, model) or 0.0
            ex = tool_input(response) or {}
            out["cost_usd"] += cost
            out["variants"][variant] = {
                "extraction": ex, "latency_s": round(time.perf_counter() - started, 3), "cost_usd": round(cost, 6),
                "fields": {f: {"truth": doc["truth"][f], "got": ex.get(f), "verdict": judge_missing(ex.get(f), doc["truth"][f])}
                           for f in FIELDS if doc["truth"][f] is None or f in ex},
            }
        absent = [f for f in FIELDS if doc["truth"][f] is None]
        out.update(absent_fields=absent, cost_usd=round(out["cost_usd"], 6),
                   invented={v: [f for f in absent if out["variants"][v]["fields"].get(f, {}).get("verdict")
                                 in ("invented", "placeholder")] for v in out["variants"]})
        return out

    # ----- 2. tool_choice on one document -----

    def tool_choice_demo(self, doc_id: str, model: str) -> dict[str, Any]:
        doc = self._doc(doc_id)
        msg = [{"role": "user", "content": f"Here is a document from the post room.\n{build_prompt(doc['text'])}"}]
        steps: list[dict[str, Any]] = []

        def step(mode: str, tool_choice: dict[str, Any], tools: list[str], note: str,
                 messages: list[dict[str, Any]] = msg) -> dict[str, Any]:
            r = self._call(model, FULL_TOKENS, LOOSE_SYSTEM, messages, tools, tool_choice)
            row = {"mode": mode, "tool_choice": tool_choice, "tools": tools, "note": note, "latency_s": r["latency_s"],
                   "cost_usd": round(r["cost_usd"], 6), "response": raw(r["response"])}
            steps.append(row)
            return row

        step("auto", {"type": "auto"}, ["extract_document"],
             "The model may call the tool or just answer in text. Nothing guarantees structured output.")
        step("any", {"type": "any"}, ["extract_invoice", "extract_receipt"],
             "The model must call a tool, and chooses which of the two document types fits.")
        meta = step("forced", TOOL_CHOICE_FORCED, ["extract_metadata", "extract_document"],
                    "The named tool runs first, whatever else is on offer: a cheap metadata step before enrichment.")
        found = next((b["input"] for b in meta["response"]["content"] if b["type"] == "tool_use"), None) or {}
        pick = "extract_receipt" if found.get("doc_type") == "receipt" else "extract_invoice"
        hint = (f"Here is a document from the post room. An earlier step found: type {found.get('doc_type')}, vendor "
                f"{found.get('vendor')}, date {found.get('date')}.\n{build_prompt(doc['text'])}")
        step("enrichment", {"type": "tool", "name": pick}, [pick],
             f"Code read doc_type from the forced step and forced {pick}. The order of steps is now guaranteed.",
             [{"role": "user", "content": hint}])
        return {"doc_id": doc_id, "model": model, "steps": steps, "truth_type": doc["type"],
                "cost_usd": round(sum(s["cost_usd"] for s in steps), 6)}

    # ----- 3. validation, retry, and knowing when to stop -----

    def validate_demo(self, doc_id: str, model: str, simulate_format_errors: bool) -> dict[str, Any]:
        doc = self._doc(doc_id)
        attempts: list[dict[str, Any]] = []
        cost, messages = 0.0, [{"role": "user", "content": build_prompt(doc["text"])}]
        previous: set[tuple[str, str]] | None = None
        status, reason = "accepted", "Every check passed."
        for n in range(1, MAX_RETRIES + 2):
            r = self._call(model, FULL_TOKENS, system_prompt(False), messages, ["extract_document"],
                           {"type": "tool", "name": "extract_document"})
            cost += r["cost_usd"]
            ex = tool_input(r["response"]) or {}
            row: dict[str, Any] = {"attempt": n, "request": messages[-1]["content"], "model_output": ex}
            if n == 1 and simulate_format_errors and ex:
                ex = corrupt(ex)
                row["simulated"] = "Rewritten by the lab to show a format error: the date became day/month/year and the total gained a £."
            problems = validate(ex, doc["type"])
            decision = retry_decision(problems, doc["text"])
            row.update(extraction=ex, issues=problems, decision={k: decision[k] for k in ("action", "reason", "stuck")})
            attempts.append(row)
            keys = issue_keys(decision["fixable"])
            if decision["action"] == "accept":
                break
            if decision["action"] == "flag":
                status, reason = "flagged", decision["reason"]
                break
            if previous is not None and keys == previous:
                status, reason = "flagged", "The same errors came back after a retry, so another try would loop."
                break
            if n > MAX_RETRIES:
                status, reason = "flagged", "Out of retries."
                break
            previous = keys
            messages = retry_messages(doc["text"], ex, decision["fixable"])
        stuck = attempts[-1]["decision"]["stuck"]
        return {"doc_id": doc_id, "model": model, "status": status, "reason": reason, "attempts": attempts,
                "left_for_review": stuck if status == "flagged" else [], "cost_usd": round(cost, 6),
                "truth": doc["truth"], "needs_contract": doc["needs_contract"]}

    # ----- runs over the whole set (few-shot, confidence and the comparison all start here) -----

    def run(self, body: dict[str, Any]) -> Iterator[str]:
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        docs = [self._doc(i) for i in body["doc_ids"]] if body.get("doc_ids") else list(DOCUMENTS)
        model, few_shot, cap = body["model"], bool(body["few_shot"]), body["budget_usd"]
        run = Run()

        def work() -> None:
            started, spent, results = time.perf_counter(), 0.0, []
            stop = {"why": None}
            lock = threading.Lock()
            run.publish({"type": "start", "total": len(docs), "model": model, "few_shot": few_shot})

            def one(doc: dict[str, Any]) -> dict[str, Any] | None:
                with lock:
                    if stop["why"]:
                        return None
                    if run.cancelled.is_set():
                        stop["why"] = "cancelled"
                        return None
                    if self.spend.over_budget:
                        stop["why"] = "Stopped: the server's budget is spent."
                        return None
                    if spent >= cap:
                        stop["why"] = f"Stopped at the run's ${cap:.2f} cap."
                        return None
                return self._extract(doc, model, few_shot)

            with ThreadPoolExecutor(WORKERS) as pool:
                for r in pool.map(one, docs):
                    if r is None:
                        continue
                    results.append(r)
                    spent += r["cost_usd"]
                    run.publish({"type": "doc", "index": len(results), "of": len(docs), "spent_usd": round(spent, 6),
                                 "result": {k: r[k] for k in ("doc_id", "type", "split", "issues", "latency_s", "cost_usd",
                                                              "error", "fields", "conflict_correct")}})
            summary = summarise(results)
            run_id = uuid.uuid4().hex[:12]
            record = {"run_id": run_id, "model": model, "few_shot": few_shot, "results": results, "summary": summary,
                      "seconds": round(time.perf_counter() - started, 1)}
            with self._lock:
                self._runs[run_id] = record
                while len(self._runs) > KEPT_RUNS:
                    self._runs.popitem(last=False)
            run.publish({"type": "done", "run_id": run_id, "model": model, "few_shot": few_shot, "summary": summary,
                         "stopped": stop["why"], "cost_usd": round(spent, 6), "seconds": record["seconds"]})

        return self.streamer.lines(run, work)

    def _get_run(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._runs.get(run_id)
        if record is None:
            raise ApiError(404, "not_found", "That run is no longer kept. Run the set again.")
        return record

    def run_result(self, run_id: str) -> dict[str, Any]:
        return self._get_run(run_id)

    def confidence(self, run_id: str, target: float, seed: int, per_stratum: int) -> dict[str, Any]:
        record = self._get_run(run_id)
        return {"run_id": run_id, "model": record["model"], **analyse(record["results"], target, seed, per_stratum)}

    def compare(self, run_a: str, run_b: str) -> dict[str, Any]:
        return compare_runs(self._get_run(run_a), self._get_run(run_b))

    # ----- 5. the Message Batches API -----

    def _batch_request(self, custom_id: str, text: str, model: str, max_tokens: int, note: str = "") -> dict[str, Any]:
        return {"custom_id": custom_id, "params": {
            "model": model, "max_tokens": max_tokens, "system": system_prompt(False),
            "messages": [{"role": "user", "content": build_prompt(text) + note}],
            "tools": [TOOLS["extract_document"]], "tool_choice": {"type": "tool", "name": "extract_document"}}}

    def batch_submit(self, model: str, doc_ids: list[str] | None, max_tokens: int) -> dict[str, Any]:
        docs = [self._doc(i) for i in doc_ids] if doc_ids else list(DOCUMENTS)
        requests = [self._batch_request(d["id"], d["text"], model, max_tokens) for d in docs]
        try:
            made = self.claude.batch_create(requests)
        except Exception as exc:
            raise to_api_error(exc) from exc
        group = uuid.uuid4().hex[:12]
        with self._lock:
            self._groups[group] = {"model": model, "docs": [d["id"] for d in docs], "outcomes": {}, "chunks": {},
                                   "expected_chunks": {}, "batches": [made["id"]], "cost_usd": 0.0, "standard_usd": 0.0}
            self._batches[made["id"]] = {"group": group, "model": model, "custom_ids": [r["custom_id"] for r in requests],
                                         "max_tokens": max_tokens, "settled": None, "round": 1,
                                         "submitted": time.strftime("%H:%M:%S")}
        return {"batch_id": made["id"], "group_id": group, "requests": len(requests), "expires_at": made["expires_at"],
                "first_request": requests[0], "max_tokens": max_tokens}

    def _settle(self, batch_id: str, state: dict[str, Any]) -> dict[str, Any]:
        """Collects an ended batch once: match on custom_id, charge half price, fold the outcomes into its group."""
        with self._lock:
            if state["settled"] is not None:
                return state["settled"]
        try:
            results = self.claude.batch_results(batch_id)
        except Exception as exc:
            raise to_api_error(exc) from exc
        outcomes = match_results(results, state["custom_ids"])
        standard = sum(cost_usd(o["usage"], state["model"]) or 0 for o in outcomes.values() if o["status"] == "ok")
        charged = self.spend.charge_usd(standard * BATCH_DISCOUNT, "batch extraction") if standard else 0.0
        group = self._groups[state["group"]]
        with self._lock:
            group["cost_usd"] += charged
            group["standard_usd"] += standard
            for cid, o in outcomes.items():
                doc_id, idx = split_custom_id(cid)
                if idx is None:
                    group["outcomes"][doc_id] = o
                else:
                    group["chunks"].setdefault(doc_id, {})[idx] = o
            for doc_id, expected in group["expected_chunks"].items():
                got = group["chunks"].get(doc_id, {})
                if len(got) == expected and all(o["status"] == "ok" for o in got.values()):
                    merged = merge_chunks([got[i]["extraction"] for i in sorted(got)])
                    group["outcomes"][doc_id] = {"status": "ok", "extraction": merged, "chunked": expected}
                elif len(got) == expected:
                    group["outcomes"][doc_id] = {"status": "failed", "reason": "chunk_failed",
                                                 "detail": "One of the chunks failed too."}
            state["settled"] = {"outcomes": outcomes, "cost_usd": round(charged, 6), "standard_usd": round(standard, 6)}
        return state["settled"]

    def _group_view(self, group_id: str) -> dict[str, Any]:
        group = self._groups[group_id]
        scored = [self._record(BY_ID[d], o["extraction"], "batch", None, 0.0)
                  for d, o in group["outcomes"].items() if o["status"] == "ok"]
        plan = resubmit_plan({d: o for d, o in group["outcomes"].items()})
        return {"group_id": group_id, "docs": len(group["docs"]), "ok": len(scored), "failed": len(plan["resubmit"]) + len(plan["held"]),
                "summary": summarise(scored) if scored else None, "plan": plan, "batches": group["batches"],
                "cost_usd": round(group["cost_usd"], 6), "standard_usd": round(group["standard_usd"], 6),
                "results": [{k: r[k] for k in ("doc_id", "type", "issues", "fields")} for r in scored]}

    def batch_poll(self, batch_id: str) -> dict[str, Any]:
        state = self._batches.get(batch_id)
        if state is None:
            raise ApiError(404, "not_found", "This server did not submit that batch (or has restarted since).")
        try:
            status = self.claude.batch_retrieve(batch_id)
        except Exception as exc:
            raise to_api_error(exc) from exc
        out: dict[str, Any] = {"batch_id": batch_id, "round": state["round"], "status": status["status"],
                               "counts": status["counts"], "ended": status["status"] == "ended",
                               "custom_ids": state["custom_ids"]}
        if out["ended"]:
            settled = self._settle(batch_id, state)
            out["this_batch"] = {"cost_usd": settled["cost_usd"], "standard_usd": settled["standard_usd"],
                                 "outcomes": {c: {k: v for k, v in o.items() if k in ("status", "reason", "detail")}
                                              for c, o in settled["outcomes"].items()}}
            out["group"] = self._group_view(state["group"])
        return out

    def batch_resubmit(self, batch_id: str) -> dict[str, Any]:
        """Sends only the failures again: split the oversized ones into chunks, resend the rest as they were."""
        state = self._batches.get(batch_id)
        if state is None or state["settled"] is None:
            raise ApiError(409, "not_ready", "Collect the batch's results before resubmitting.")
        group = self._groups[state["group"]]
        plan = resubmit_plan(group["outcomes"])["resubmit"]
        if not plan:
            raise ApiError(409, "nothing_to_do", "Nothing failed that is worth sending again.")
        model, requests = state["model"], []
        for row in plan:
            doc = BY_ID[row["doc_id"]]
            if row["action"] == "chunk":
                pieces = chunk_document(doc["text"])
                group["expected_chunks"][doc["id"]] = len(pieces)
                group["chunks"].pop(doc["id"], None)
                for i, piece in enumerate(pieces, 1):
                    note = f"\n\nThis is part {i} of {len(pieces)} of a long document. Extract only what this part shows."
                    requests.append(self._batch_request(chunk_custom_id(doc["id"], i), piece, model, FULL_TOKENS, note))
            else:
                requests.append(self._batch_request(doc["id"], doc["text"], model, FULL_TOKENS))
        try:
            made = self.claude.batch_create(requests)
        except Exception as exc:
            raise to_api_error(exc) from exc
        with self._lock:
            group["batches"].append(made["id"])
            self._batches[made["id"]] = {"group": state["group"], "model": model, "round": state["round"] + 1,
                                         "custom_ids": [r["custom_id"] for r in requests], "max_tokens": FULL_TOKENS,
                                         "settled": None, "submitted": time.strftime("%H:%M:%S")}
        return {"batch_id": made["id"], "group_id": state["group"], "requests": len(requests), "plan": plan,
                "custom_ids": [r["custom_id"] for r in requests]}
