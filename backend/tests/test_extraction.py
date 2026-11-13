"""Structured extraction: the document set, schemas, semantic checks, the retry rule, scoring, calibration, sampling,
batch bookkeeping, and the service driven by a scripted Claude and a fake Batches API. No network, no cost."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import backend.app.api as api_package
from backend.app.core.errors import ApiError
from backend.app.gateways.claude import ClaudeGateway
from backend.app.main import create_app
from backend.app.services import extraction_logic as L
from backend.app.services.extraction import ExtractionService, judge_missing
from backend.app.services.extraction_docs import BY_ID, DOCUMENTS, EXAMPLES, FIELDS
from backend.app.services.runs import RunRegistry, RunStreamer
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, reply, text, use
from backend.tests.test_api import LAB

MODEL = "claude-haiku-5-5"


def perfect(doc: dict[str, Any], **override: Any) -> dict[str, Any]:
    """What a flawless model would extract from this document."""
    t = doc["truth"]
    ex: dict[str, Any] = {k: t[k] for k in FIELDS}
    ex.update(line_items=[{"description": f"line {i}", "quantity": None, "unit": None, "amount": a}
                          for i, a in enumerate(doc["line_amounts"])],
              calculated_total=round(sum(doc["line_amounts"]), 2), conflict_detected=doc["conflict"],
              confidence={k: 0.95 for k in FIELDS})
    ex.update(override)
    return ex


def result(doc_id: str, ex: dict[str, Any] | None = None, **extra: Any) -> dict[str, Any]:
    doc = BY_ID[doc_id]
    ex = perfect(doc) if ex is None else ex
    return {"doc_id": doc_id, "type": doc["type"], "split": doc["split"], "extraction": ex,
            "issues": L.validate(ex, doc["type"]), "latency_s": 1.0, "cost_usd": 0.001, **L.score(doc, ex), **extra}


def service(script: list[list[dict]], streamer: RunStreamer | None = None) -> tuple[ExtractionService, ScriptedClient]:
    fake = ScriptedClient(script)
    return ExtractionService(ClaudeGateway(fake), SpendTracker(5.0), streamer), fake


# ---------- the document set ----------

def test_the_set_is_24_labelled_documents_and_the_truth_is_consistent() -> None:
    assert len(DOCUMENTS) == 24 and len({d["id"] for d in DOCUMENTS}) == 24
    by_type = {t: [d for d in DOCUMENTS if d["type"] == t] for t in ("invoice", "receipt", "purchase_order")}
    assert [len(v) for v in by_type.values()] == [9, 8, 7]
    for d in DOCUMENTS:
        summed = round(sum(d["line_amounts"]), 2)
        assert (summed != d["truth"]["stated_total"]) == d["conflict"], d["id"]
        assert d["split"] in ("validation", "test") and set(d["truth"]) == set(FIELDS)
        if d["type"] == "receipt":
            assert d["truth"]["payment_terms_days"] is None
    assert {d["split"] for d in DOCUMENTS if d["type"] == "invoice"} == {"validation", "test"}
    assert [d["id"] for d in DOCUMENTS if d["needs_contract"]] == ["inv-05", "po-04"]
    assert sum(d["conflict"] for d in DOCUMENTS) == 3
    assert all(round(sum(l["amount"] for l in e["extraction"]["line_items"]), 2) == e["extraction"]["stated_total"]
               for e in EXAMPLES) and not {e["text"] for e in EXAMPLES} & {d["text"] for d in DOCUMENTS}


# ---------- schemas ----------

def test_the_nullable_schema_allows_null_and_the_required_one_does_not() -> None:
    nullable, strict = L.extraction_schema(), L.extraction_schema(nullable=False)
    assert "null" in nullable["properties"]["vat_number"]["type"] and strict["properties"]["vat_number"]["type"] == "string"
    assert None in nullable["properties"]["currency"]["enum"] and None not in strict["properties"]["currency"]["enum"]
    assert "unclear" in nullable["properties"]["category"]["enum"] and "other" in nullable["properties"]["category"]["enum"]
    assert "category_detail" in nullable["properties"] and "category_detail" not in nullable["required"]  # optional
    assert set(nullable["required"]) >= set(FIELDS) and nullable["additionalProperties"] is False
    receipt = L.extraction_schema("receipt")
    assert "payment_terms_days" not in receipt["properties"] and "payment_terms_days" not in receipt["properties"]["confidence"]["properties"]
    assert set(L.TOOLS) == {"extract_document", "extract_invoice", "extract_receipt", "extract_metadata"}


def test_few_shot_adds_three_examples_to_the_system_prompt() -> None:
    assert "<example>" not in L.system_prompt(False)
    assert L.system_prompt(True).count("<example>") == 3 and "Fernside" in L.system_prompt(True)


def test_missing_values_are_judged_null_placeholder_or_invented() -> None:
    assert judge_missing(None, None) == "null" and judge_missing("N/A", None) == "placeholder"
    assert judge_missing("2026-01-01", None) == "invented" and judge_missing("x", "x") == "correct"


# ---------- semantic validation ----------

def test_a_correct_extraction_passes_every_check() -> None:
    doc = BY_ID["inv-01"]
    assert L.validate(perfect(doc), "invoice") == []


def test_format_errors_are_caught_in_code() -> None:
    bad = perfect(BY_ID["inv-01"], date="14/03/26", stated_total="£40.50")
    kinds = {(i["field"], i["kind"]) for i in L.validate(bad, "invoice")}
    assert ("date", "format") in kinds and ("stated_total", "format") in kinds
    assert L.parse_iso_date("2026-02-30") is None and L.parse_iso_date("2026-03-14") is not None
    assert ("currency", "format") in {(i["field"], i["kind"]) for i in L.validate(perfect(BY_ID["inv-01"], currency="XYZ"), "invoice")}
    assert L.corrupt(perfect(BY_ID["inv-01"]))["date"] == "14/03/26"


def test_line_items_must_sum_to_the_total_unless_the_conflict_is_flagged() -> None:
    doc = BY_ID["inv-04"]
    flagged = L.validate(perfect(doc), "invoice")
    assert [(i["field"], i["kind"]) for i in flagged] == [("stated_total", "conflict")]
    unflagged = L.validate(perfect(doc, conflict_detected=False), "invoice")
    assert ("stated_total", "arithmetic") in {(i["field"], i["kind"]) for i in unflagged}
    wrong_calc = L.validate(perfect(BY_ID["inv-01"], calculated_total=99.0), "invoice")
    assert wrong_calc[0]["field"] == "calculated_total" and "40.5" in wrong_calc[0]["message"]
    assert ("conflict_detected", "arithmetic") in {(i["field"], i["kind"]) for i in
                                                    L.validate(perfect(BY_ID["inv-01"], conflict_detected=True), "invoice")}


def test_required_fields_depend_on_the_document_type() -> None:
    ex = perfect(BY_ID["rec-01"])
    assert L.validate(ex, "receipt") == []  # a receipt has no payment terms
    assert ("payment_terms_days", "missing") in {(i["field"], i["kind"]) for i in L.validate(ex, "invoice")}
    assert ("currency", "unsupported") in {(i["field"], i["kind"]) for i in L.validate(perfect(BY_ID["inv-01"], currency="other"), "invoice")}


# ---------- retry, or stop ----------

def test_a_format_error_is_worth_a_retry() -> None:
    doc = BY_ID["inv-01"]
    problems = L.validate(perfect(doc, date="14/03/26"), "invoice")
    decision = L.retry_decision(problems, doc["text"])
    assert decision["action"] == "retry" and decision["fixable"][0]["field"] == "date"
    assert L.retry_decision([], doc["text"])["action"] == "accept"


def test_retry_cannot_help_when_the_terms_are_in_an_attached_contract() -> None:
    for doc_id in ("inv-05", "po-04"):
        doc = BY_ID[doc_id]
        decision = L.retry_decision(L.validate(perfect(doc), doc["type"]), doc["text"])
        assert decision["action"] == "flag" and "attached" in decision["reason"] and decision["fixable"] == []


def test_retry_cannot_help_for_an_ambiguous_currency_or_a_flagged_conflict() -> None:
    doc = BY_ID["inv-08"]
    flag = L.retry_decision(L.validate(perfect(doc), "invoice"), doc["text"])
    assert flag["action"] == "flag" and "bare $" in flag["reason"]
    doc = BY_ID["inv-04"]
    assert L.retry_decision(L.validate(perfect(doc), "invoice"), doc["text"])["action"] == "flag"
    doc = BY_ID["inv-06"]  # no date is printed at all
    assert "No date" in L.retry_decision(L.validate(perfect(doc), "invoice"), doc["text"])["reason"]


def test_a_missing_value_that_is_in_the_text_is_worth_a_retry() -> None:
    doc = BY_ID["inv-01"]
    problems = L.validate(perfect(doc, date=None), "invoice")  # the model missed a date that is printed
    assert L.retry_decision(problems, doc["text"])["action"] == "retry"


def test_the_retry_request_carries_the_document_the_failed_extraction_and_the_errors() -> None:
    doc = BY_ID["inv-01"]
    ex = perfect(doc, date="14/03/26")
    problems = L.validate(ex, "invoice")
    [message] = L.retry_messages(doc["text"], ex, problems)
    body = message["content"]
    assert message["role"] == "user" and doc["text"] in body and '"14/03/26"' in body
    assert problems[0]["message"] in body and "never invent" in body


# ---------- scoring ----------

def test_a_perfect_extraction_scores_full_marks_on_every_document() -> None:
    for d in DOCUMENTS:
        s = L.score(d, perfect(d))
        assert all(f["correct"] for f in s["fields"].values()), d["id"]
        assert s["conflict_correct"]


def test_scoring_handles_numbers_dates_nulls_and_placeholders() -> None:
    doc = BY_ID["rec-04"]  # no date, no number
    s = L.score(doc, perfect(doc, date="2026-01-01", document_number="N/A", vendor="lantern coffee  house"))
    assert not s["fields"]["date"]["correct"] and not s["fields"]["date"]["empty"]  # invented, not empty
    assert s["fields"]["document_number"]["correct"]  # a placeholder counts as null, which is right here
    assert s["fields"]["vendor"]["correct"]
    inv = BY_ID["inv-01"]
    s = L.score(inv, perfect(inv, document_number="N/A", stated_total="40.5", payment_terms_days=None, currency="unclear"))
    f = s["fields"]
    assert f["document_number"]["empty"] and f["stated_total"]["correct"] and f["payment_terms_days"]["empty"]
    assert f["currency"]["empty"] and not f["currency"]["correct"]
    assert L.score(BY_ID["inv-08"], perfect(BY_ID["inv-08"]))["fields"]["currency"]["correct"]  # unclear is the right answer
    none = L.score(inv, None)
    assert not any(f["correct"] for f in none["fields"].values()) and none["conflict_correct"] is False


def test_accuracy_by_type_and_field_shows_what_a_good_overall_figure_hides() -> None:
    results = [result(d["id"]) for d in DOCUMENTS]
    for r in results[:9]:  # the VAT number is wrong on nine documents
        r["fields"]["vat_number"] = {**r["fields"]["vat_number"], "correct": False, "got": "wrong"}
    summary = L.summarise(results)
    assert summary["overall"] > 0.95 and summary["by_field"]["vat_number"]["accuracy"] < 0.7
    assert summary["by_type"]["invoice"]["accuracy"] < summary["by_type"]["receipt"]["accuracy"]
    assert summary["weak_spots"][0]["name"] == "vat_number" and summary["docs_perfect"] == 15
    assert summary["cost_usd"] == pytest.approx(0.024) and summary["latency_mean_s"] == 1.0


# ---------- confidence ----------

def test_calibration_gives_accuracy_per_band() -> None:
    items = [{"confidence": 0.99, "correct": True}] * 8 + [{"confidence": 0.97, "correct": False}] * 2 + [
        {"confidence": 0.6, "correct": True}, {"confidence": 0.6, "correct": False}, {"confidence": None, "correct": True}]
    bands = {b["band"]: b for b in L.calibration(items)}
    assert bands["0.95 to 1.00"]["n"] == 10 and bands["0.95 to 1.00"]["accuracy"] == 0.8
    assert bands["0.50 to 0.70"]["accuracy"] == 0.5 and bands["0.00 to 0.50"]["accuracy"] is None


def test_the_threshold_is_the_lowest_confidence_that_reaches_the_target() -> None:
    items = ([{"confidence": 0.99, "correct": True}] * 10 + [{"confidence": 0.9, "correct": True}] * 6
             + [{"confidence": 0.8, "correct": False}] * 4 + [{"confidence": 0.5, "correct": False}] * 2)
    chosen = L.pick_threshold(items, 0.95)
    assert chosen["reached"] and chosen["threshold"] == 0.9 and chosen["accuracy_above"] == 1.0
    assert chosen["coverage"] == pytest.approx(16 / 22, abs=1e-3)
    nothing = L.pick_threshold([{"confidence": 0.9, "correct": False}] * 8, 0.95)
    assert not nothing["reached"] and nothing["threshold"] > 1


def test_routing_sends_low_confidence_failed_checks_and_conflicts_to_a_person() -> None:
    good = result("inv-01")
    assert L.route(good, 0.9)["review"] is False
    low = result("inv-01", perfect(BY_ID["inv-01"], confidence={**{k: 0.95 for k in FIELDS}, "vat_number": 0.6}))
    assert L.route(low, 0.9)["reasons"] == ["vat_number confidence 0.60"]
    assert L.route(result("inv-04"), 0.9)["review"] is True  # a flagged conflict
    assert L.route({**good, "extraction": None}, 0.9)["review"]


def test_the_stratified_sample_is_seeded_and_takes_the_same_number_from_each_stratum() -> None:
    items = [{"doc_id": d["id"], "type": d["type"]} for d in DOCUMENTS]
    a = L.stratified_sample(items, "type", 2, seed=7)
    assert a == L.stratified_sample(list(reversed(items)), "type", 2, seed=7)  # same whatever the input order
    assert a != L.stratified_sample(items, "type", 2, seed=8)
    counts = {t: sum(1 for i in a if i["type"] == t) for t in ("invoice", "receipt", "purchase_order")}
    assert counts == {"invoice": 2, "receipt": 2, "purchase_order": 2}
    assert len(L.stratified_sample(items[:1], "type", 5, seed=1)) == 1


def test_analyse_calibrates_on_validation_and_applies_the_threshold_to_test() -> None:
    results = []
    for d in DOCUMENTS:
        ex = perfect(d)
        if d["id"] in ("inv-03", "rec-05"):  # confidently wrong
            ex["vendor"] = "Somebody Else"
        results.append(result(d["id"], ex))
    out = L.analyse(results, 0.95, seed=3, per_stratum=1)
    assert out["validation_docs"] == 12 and out["test_docs"] == 12
    assert sum(b["n"] for b in out["calibration"]) == 12 * 8
    assert out["test"]["auto"] + out["test"]["review"] == 12 and len(out["test"]["routing"]) == 12
    assert out["spot_check"] and all(s["doc_id"] in BY_ID for s in out["spot_check"])
    assert out["overall"]["by_type"].keys() == {"invoice", "receipt", "purchase_order"}


# ---------- the comparison ----------

def test_compare_lists_regressions_and_improvements_by_field() -> None:
    a = {"run_id": "a" * 12, "model": MODEL, "few_shot": False, "results": [result("inv-01"), result("rec-01")]}
    worse = perfect(BY_ID["inv-01"], vendor="Wrong Ltd")
    better = [result("inv-01", worse), result("rec-01")]
    b = {"run_id": "b" * 12, "model": "claude-sonnet-5-5", "few_shot": False, "results": better}
    for r in (a, b):
        r["summary"] = L.summarise(r["results"])
    out = L.compare_runs(a, b)
    assert out["regressions"] == [{"doc_id": "inv-01", "field": "vendor", "truth": "Harlow & Finch Stationery Ltd",
                                   "a": "Harlow & Finch Stationery Ltd", "b": "Wrong Ltd"}]
    assert out["by_field"]["vendor"]["delta"] == -0.5 and out["overall_delta"] < 0 and not out["improvements"]
    assert out["cost_per_1000_docs"]["a"] == 1.0


# ---------- batches: custom_id, chunks, resubmission ----------

def test_a_long_document_is_split_into_chunks_that_merge_back() -> None:
    doc = BY_ID["po-07"]
    pieces = L.chunk_document(doc["text"])
    assert len(pieces) == 3
    head = doc["text"].split("\n")[:6]
    assert all(p.startswith("\n".join(head)) for p in pieces)
    assert "Order total" in pieces[-1] and not any("Order total" in p for p in pieces[:-1])
    body_rows = [l for p in pieces for l in p.split("\n")[6:] if l.strip() and "total" not in l.lower() and "terms" not in l.lower()]
    assert len(body_rows) == 30
    amounts = doc["line_amounts"]
    parts = []
    for i, p in enumerate(pieces):
        chunk_amounts = amounts[i * 12:(i + 1) * 12]
        last = i == len(pieces) - 1
        parts.append(perfect(doc, line_items=[{"description": "x", "quantity": None, "unit": None, "amount": a} for a in chunk_amounts],
                             stated_total=doc["truth"]["stated_total"] if last else None,
                             payment_terms_days=30 if last else None,
                             calculated_total=round(sum(chunk_amounts), 2), conflict_detected=False))
    merged = L.merge_chunks(parts)
    assert len(merged["line_items"]) == 30 and merged["calculated_total"] == doc["truth"]["stated_total"]
    assert merged["payment_terms_days"] == 30 and merged["conflict_detected"] is False and merged["vendor"] == "Ridgeway Builders Merchant"
    assert L.split_custom_id("po-07__2") == ("po-07", 2) and L.split_custom_id("inv-01") == ("inv-01", None)


def _succeeded(cid: str, ex: dict[str, Any], stop: str = "tool_use") -> dict[str, Any]:
    blocks = [use("extract_document", ex)] if stop == "tool_use" else [text("{\"vendor\": ")]
    return {"custom_id": cid, "type": "succeeded", "message": reply(MODEL, *blocks, stop=stop)}


def test_results_match_on_custom_id_whatever_order_they_arrive_in() -> None:
    ids = ["inv-01", "inv-02", "po-07", "rec-01", "rec-02", "rec-03", "rec-04"]
    results = [_succeeded("rec-01", perfect(BY_ID["rec-01"])), _succeeded("inv-02", perfect(BY_ID["inv-02"])),
               {"custom_id": "rec-02", "type": "errored", "error_type": "overloaded_error", "error_message": "busy"},
               _succeeded("po-07", {}, stop="max_tokens"), {"custom_id": "rec-03", "type": "expired"},
               {"custom_id": "inv-01", "type": "errored", "error_type": "invalid_request_error", "error_message": "bad"},
               {"custom_id": "not-ours", "type": "succeeded", "message": None}]
    out = L.match_results(results, ids)
    assert out["inv-02"]["extraction"]["vendor"] == "Brightwater IT Services Ltd" and out["rec-01"]["status"] == "ok"
    assert {k: out[k]["reason"] for k in ("rec-02", "po-07", "rec-03", "inv-01", "rec-04")} == {
        "rec-02": "overloaded_error", "po-07": "max_tokens", "rec-03": "expired", "inv-01": "invalid_request_error",
        "rec-04": "missing"}
    plan = L.resubmit_plan(out)
    assert {r["doc_id"]: r["action"] for r in plan["resubmit"]} == {"rec-02": "resend", "po-07": "chunk", "rec-03": "resend",
                                                                    "rec-04": "resend"}
    assert [r["doc_id"] for r in plan["held"]] == ["inv-01"]  # an invalid request would only fail again


class FakeBatchGateway(ClaudeGateway):
    """The Batches API without the network: results come back shuffled, with one oversized document cut off."""

    def __init__(self, client: Any, fail_chunks: bool = False):
        super().__init__(client)
        self.created: list[list[dict[str, Any]]] = []
        self.polls = 0
        self.fail_chunks = fail_chunks

    def batch_create(self, requests: list[dict[str, Any]]) -> dict[str, Any]:
        self.created.append(requests)
        return {"id": f"msgbatch_fake{len(self.created)}", "expires_at": "2026-12-31T00:00:00Z"}

    def batch_retrieve(self, batch_id: str) -> dict[str, Any]:
        self.polls += 1
        done = self.polls > 1
        return {"id": batch_id, "status": "ended" if done else "in_progress",
                "counts": {"processing": 0 if done else 24, "succeeded": 0, "errored": 0, "canceled": 0, "expired": 0}}

    def batch_results(self, batch_id: str) -> list[dict[str, Any]]:
        out = []
        for request in reversed(self.created[int(batch_id[-1]) - 1]):  # not the order sent
            cid = request["custom_id"]
            doc_id, _, idx = cid.partition("__")
            if doc_id == "po-07" and not idx:
                out.append(_succeeded(cid, {}, stop="max_tokens"))
            elif doc_id == "rec-02" and batch_id.endswith("1"):
                out.append({"custom_id": cid, "type": "errored", "error_type": "overloaded_error", "error_message": ""})
            elif idx:
                if self.fail_chunks:
                    out.append({"custom_id": cid, "type": "expired"})
                    continue
                doc, i = BY_ID[doc_id], int(idx)
                chunk = doc["line_amounts"][(i - 1) * 12:i * 12]
                last = i == 3
                out.append(_succeeded(cid, perfect(doc, line_items=[{"description": "x", "quantity": None, "unit": None, "amount": a} for a in chunk],
                                                   calculated_total=round(sum(chunk), 2), conflict_detected=False,
                                                   stated_total=doc["truth"]["stated_total"] if last else None,
                                                   payment_terms_days=30 if last else None)))
            else:
                out.append(_succeeded(cid, perfect(BY_ID[doc_id])))
        return out


def test_a_batch_is_submitted_polled_matched_and_only_the_failures_are_resubmitted() -> None:
    gateway = FakeBatchGateway(ScriptedClient([]))
    spend = SpendTracker(5.0)
    svc = ExtractionService(gateway, spend)
    sub = svc.batch_submit(MODEL, None, 700)
    first = gateway.created[0]
    assert sub["requests"] == 24 and [r["custom_id"] for r in first] == [d["id"] for d in DOCUMENTS]
    assert first[0]["params"]["tool_choice"] == {"type": "tool", "name": "extract_document"}
    assert first[0]["params"]["max_tokens"] == 700

    waiting = svc.batch_poll(sub["batch_id"])
    assert waiting["status"] == "in_progress" and not waiting["ended"] and "group" not in waiting and spend.spent_usd == 0

    done = svc.batch_poll(sub["batch_id"])
    assert done["ended"] and done["group"]["ok"] == 22 and done["group"]["failed"] == 2
    actions = {r["doc_id"]: r["action"] for r in done["group"]["plan"]["resubmit"]}
    assert actions == {"po-07": "chunk", "rec-02": "resend"}
    assert done["group"]["summary"]["overall"] == 1.0
    standard = done["group"]["standard_usd"]
    assert standard > 0 and done["group"]["cost_usd"] == pytest.approx(standard * 0.5) and spend.spent_usd == pytest.approx(standard * 0.5)
    svc.batch_poll(sub["batch_id"])  # collecting twice must not charge twice
    assert spend.spent_usd == pytest.approx(standard * 0.5)

    again = svc.batch_resubmit(sub["batch_id"])
    second = gateway.created[1]
    assert sorted(again["custom_ids"]) == ["po-07__1", "po-07__2", "po-07__3", "rec-02"]  # only the failures
    assert all(r["params"]["max_tokens"] == 1500 for r in second)
    assert any("part 1 of 3" in r["params"]["messages"][0]["content"] for r in second)
    final = svc.batch_poll(again["batch_id"])
    group = final["group"]
    assert final["round"] == 2 and group["ok"] == 24 and group["failed"] == 0 and group["summary"]["overall"] == 1.0
    assert group["plan"] == {"resubmit": [], "held": []}
    with pytest.raises(ApiError):
        svc.batch_resubmit(again["batch_id"])  # nothing left to send


def test_chunks_that_fail_again_keep_the_document_failed() -> None:
    gateway = FakeBatchGateway(ScriptedClient([]), fail_chunks=True)
    svc = ExtractionService(gateway, SpendTracker(5.0))
    sub = svc.batch_submit(MODEL, ["po-07", "rec-01"], 700)
    svc.batch_poll(sub["batch_id"])
    svc.batch_poll(sub["batch_id"])
    again = svc.batch_resubmit(sub["batch_id"])
    group = svc.batch_poll(again["batch_id"])["group"]
    assert group["ok"] == 1 and group["failed"] == 1
    with pytest.raises(ApiError):
        svc.batch_poll("msgbatch_unknown")


# ---------- the service with a scripted Claude ----------

def test_one_extraction_is_a_forced_tool_call_then_validated_and_scored() -> None:
    doc = BY_ID["inv-01"]
    svc, fake = service([[use("extract_document", perfect(doc))]])
    r = svc._extract(doc, MODEL, few_shot=True)
    params = fake.calls[0][1]
    assert params["tool_choice"] == {"type": "tool", "name": "extract_document"}
    assert [t["name"] for t in params["tools"]] == ["extract_document"] and "<example>" in params["system"]
    assert doc["text"] in params["messages"][0]["content"]
    assert r["issues"] == [] and all(f["correct"] for f in r["fields"].values()) and r["cost_usd"] > 0
    svc2, _ = service([[text("Sorry, I cannot.")]])
    broken = svc2._extract(doc, MODEL, few_shot=False)
    assert broken["extraction"] is None and "No tool call" in broken["error"] and not any(f["correct"] for f in broken["fields"].values())


def test_the_required_schema_invents_a_date_where_the_nullable_one_returns_null() -> None:
    doc = BY_ID["rec-04"]
    invented = perfect(doc, date="2026-03-14", document_number="N/A", vat_number="GB000000000")
    svc, fake = service([[use("extract_document", invented)], [use("extract_document", perfect(doc))]])
    out = svc.schema_demo("rec-04", MODEL)
    assert fake.calls[0][1]["tools"][0]["input_schema"]["properties"]["date"]["type"] == "string"
    assert fake.calls[1][1]["tools"][0]["input_schema"]["properties"]["date"]["type"] == ["string", "null"]
    assert out["invented"]["required"] == ["document_number", "date", "vat_number"] and out["invented"]["nullable"] == []
    assert out["variants"]["nullable"]["fields"]["date"]["verdict"] == "null" and out["cost_usd"] > 0


def test_tool_choice_demo_sends_auto_any_forced_and_an_enrichment_step() -> None:
    doc = BY_ID["rec-01"]
    svc, fake = service([[text("This looks like a bakery receipt.")], [use("extract_receipt", perfect(doc))],
                         [use("extract_metadata", {"doc_type": "receipt", "vendor": "The Corner Bakery", "date": "2026-09-08"})],
                         [use("extract_receipt", perfect(doc))]])
    out = svc.tool_choice_demo("rec-01", MODEL)
    choices = [c[1]["tool_choice"] for c in fake.calls]
    assert choices == [{"type": "auto"}, {"type": "any"}, {"type": "tool", "name": "extract_metadata"},
                       {"type": "tool", "name": "extract_receipt"}]
    assert [t["name"] for t in fake.calls[1][1]["tools"]] == ["extract_invoice", "extract_receipt"]
    assert out["steps"][0]["response"]["content"][0]["type"] == "text"  # auto may answer in words
    assert out["steps"][1]["response"]["content"][0]["name"] == "extract_receipt"
    assert "type receipt" in fake.calls[3][1]["messages"][0]["content"]


def test_validation_retries_a_format_error_with_the_errors_in_the_request() -> None:
    doc = BY_ID["inv-01"]
    svc, fake = service([[use("extract_document", perfect(doc))], [use("extract_document", perfect(doc))]])
    out = svc.validate_demo("inv-01", MODEL, simulate_format_errors=True)
    assert out["status"] == "accepted" and len(out["attempts"]) == 2 and len(fake.calls) == 2
    assert out["attempts"][0]["issues"] and out["attempts"][0]["simulated"] and out["attempts"][1]["issues"] == []
    follow_up = fake.calls[1][1]["messages"][0]["content"]
    assert "not a real date" in follow_up and doc["text"] in follow_up and "14/03/26" in follow_up


def test_validation_stops_and_flags_when_the_information_is_not_in_the_document() -> None:
    doc = BY_ID["inv-05"]
    svc, fake = service([[use("extract_document", perfect(doc))]])
    out = svc.validate_demo("inv-05", MODEL, simulate_format_errors=False)
    assert out["status"] == "flagged" and len(fake.calls) == 1 and "attached contract" in out["reason"]
    assert out["left_for_review"][0]["field"] == "payment_terms_days" and out["needs_contract"]


def test_validation_does_not_loop_when_the_same_errors_come_back() -> None:
    doc = BY_ID["inv-01"]
    bad = perfect(doc, date="14/03/26")
    svc, fake = service([[use("extract_document", bad)], [use("extract_document", bad)], [use("extract_document", bad)]])
    out = svc.validate_demo("inv-01", MODEL, simulate_format_errors=False)
    assert out["status"] == "flagged" and len(fake.calls) == 2 and "loop" in out["reason"]


def test_a_full_run_streams_progress_and_keeps_the_run_for_analysis() -> None:
    import json as _json
    streamer = RunStreamer(RunRegistry(), 0.2)
    ids = ["inv-01", "inv-02", "rec-01"]
    svc, fake = service([[use("extract_document", perfect(BY_ID["inv-01"]))] for _ in ids], streamer)
    lines = [_json.loads(l) for l in svc.run({"model": MODEL, "few_shot": False, "doc_ids": ids, "budget_usd": 0.5}) if l.strip()]
    kinds = [e["type"] for e in lines]
    assert kinds[0] == "run" and kinds[1] == "start" and kinds.count("doc") == 3 and kinds[-1] == "done"
    done = lines[-1]
    assert done["summary"]["docs"] == 3 and done["cost_usd"] > 0
    stored = svc.confidence(done["run_id"], 0.95, 1, 1)
    assert stored["run_id"] == done["run_id"] and svc.run_result(done["run_id"])["model"] == MODEL
    with pytest.raises(ApiError):
        svc.compare(done["run_id"], "0" * 12)


def test_a_run_stops_at_its_cap() -> None:
    import json as _json
    streamer = RunStreamer(RunRegistry(), 0.2)
    svc, _ = service([[use("extract_document", perfect(BY_ID["inv-01"]))] for _ in range(3)], streamer)
    svc.spend.spent_usd = svc.spend.budget_usd  # already over budget
    lines = [_json.loads(l) for l in svc.run({"model": MODEL, "few_shot": False, "doc_ids": ["inv-01"], "budget_usd": 0.5}) if l.strip()]
    assert lines[-1]["type"] == "done" and "budget" in lines[-1]["stopped"] and lines[-1]["summary"]["docs"] == 0


# ---------- routes (run once the router is wired) ----------

def _wired() -> bool:
    return "extraction" in vars(api_package)


@pytest.mark.skipif(not _wired(), reason="route not wired yet")
def test_routes(tmp_path: Path) -> None:
    doc = BY_ID["inv-01"]
    fake = ScriptedClient([[use("extract_document", perfect(doc))]])
    settings = Settings(port=8000, budget_usd=1.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    info = client.get("/api/extraction/info", headers=LAB).json()
    assert len(info["documents"]) == 24 and info["documents"][0]["truth"]["vendor"]
    assert client.post("/api/extraction/schema", json={"doc_id": "inv-01"}).status_code in (400, 403)  # no lab header
    assert client.post("/api/extraction/validate", headers=LAB, json={"doc_id": "zzz"}).status_code == 400
    assert client.post("/api/extraction/validate", headers=LAB,
                       json={"doc_id": "inv-01", "model": "gpt-5.4-mini"}).status_code == 400  # Claude only
    assert client.get("/api/extraction/batch/not-a-batch", headers=LAB).status_code == 400
    r = client.post("/api/extraction/validate", headers=LAB, json={"doc_id": "inv-01", "model": MODEL})
    assert r.status_code == 200 and r.json()["status"] == "accepted"
    lines = [json.loads(l) for l in client.post("/api/extraction/run", headers=LAB, json={
        "model": MODEL, "few_shot": False, "doc_ids": []}).text.splitlines() if l.strip()]
    assert lines[0]["type"] == "run"


def test_every_batch_custom_id_is_one_the_batches_api_accepts() -> None:
    """The API allows only letters, digits, "_" and "-" (up to 64 characters); a "#" was refused live."""
    import re
    from backend.app.services.extraction_docs import DOCUMENTS
    ids = [d["id"] for d in DOCUMENTS]
    ids += [L.chunk_custom_id(i, n) for i in ids for n in (1, 2, 3)]
    assert all(re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", i) for i in ids)
    assert all(L.split_custom_id(L.chunk_custom_id(i, 2)) == (i, 2) for i in ids[:24])
