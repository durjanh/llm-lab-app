"""Structured extraction, the parts that need no model: the tool schemas, the semantic checks, the "retry cannot help"
rule, scoring against ground truth, calibration, stratified sampling and batch bookkeeping. Standard library only, so
each rule can be tested on its own."""
from __future__ import annotations

import copy
import json
import random
import re
from datetime import date
from typing import Any

from .extraction_docs import CATEGORIES, DOC_TYPES, EXAMPLES, FIELDS

CURRENCIES = ["GBP", "EUR", "USD", "other", "unclear"]
KNOWN_CURRENCIES = {"GBP", "EUR", "USD"}
NEEDS_TERMS = {"invoice", "purchase_order"}  # a receipt is paid at the till, so it has no payment terms
TOLERANCE = 0.01
PLACEHOLDERS = {"", "n/a", "na", "none", "null", "unknown", "-", "--", "tbc", "not provided", "0000-00-00"}


# ----- schemas and tools -----

def extraction_schema(kind: str = "document", nullable: bool = True) -> dict[str, Any]:
    """The extraction tool's input schema. nullable=False is the cautionary version: every field required and never null."""
    def t(base: str) -> Any:
        return [base, "null"] if nullable else base

    currency: dict[str, Any] = {"type": t("string"), "enum": CURRENCIES + ([None] if nullable else []),
                                "description": "ISO code. 'other' for a currency not listed. 'unclear' when the symbol could "
                                               "mean several currencies (a bare $). null when no currency is printed."
                                if nullable else "ISO code. 'other' for a currency not listed. 'unclear' when ambiguous."}
    props: dict[str, Any] = {
        "vendor": {"type": "string", "description": "The business the goods or services come from, as printed."},
        "document_number": {"type": t("string"), "description": "Invoice, receipt or order number, as printed."},
        "date": {"type": t("string"), "description": "Issue date as YYYY-MM-DD. UK style dates are day first."},
        "currency": currency,
        "line_items": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["description", "quantity", "unit", "amount"],
            "properties": {"description": {"type": "string"}, "quantity": {"type": ["number", "null"]},
                           "unit": {"type": ["string", "null"], "description": "kg, litre, dozen, box ... as printed"},
                           "amount": {"type": "number", "description": "The line's total. Negative for a discount."}}}},
        "stated_total": {"type": t("number"), "description": "The total the document itself states. Never corrected."},
        "calculated_total": {"type": "number", "description": "The sum of the line item amounts, worked out by you."},
        "conflict_detected": {"type": "boolean", "description": "true when calculated_total and stated_total differ."},
        "vat_number": {"type": t("string"), "description": "The seller's VAT number, if one is printed."},
        "category": {"type": "string", "enum": CATEGORIES,
                     "description": "What was bought. 'other' needs category_detail. 'unclear' when it cannot be told."},
        "category_detail": {"type": "string", "description": "Only when category is 'other': a few words."},
    }
    if kind != "receipt":
        props["payment_terms_days"] = {"type": t("integer"), "description": "Days allowed to pay. null if not stated."}
    scored = [f for f in FIELDS if f in props]
    props["confidence"] = {"type": "object", "additionalProperties": False, "required": scored,
                           "properties": {f: {"type": "number", "description": "0 to 1: how likely this value is right"}
                                          for f in scored}}
    return {"type": "object", "additionalProperties": False,
            "required": [k for k in props if k != "category_detail"], "properties": props}


def tool_def(name: str, description: str, schema: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "description": description, "input_schema": schema}


METADATA_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["doc_type", "vendor", "date"],
    "properties": {"doc_type": {"type": "string", "enum": DOC_TYPES + ["other"]},
                   "vendor": {"type": ["string", "null"]}, "date": {"type": ["string", "null"], "description": "YYYY-MM-DD"}}}

TOOLS: dict[str, dict[str, Any]] = {
    "extract_document": tool_def("extract_document", "Record the structured data from one business document (an invoice, "
                                 "a till receipt or a purchase order). Call it once per document.", extraction_schema()),
    "extract_invoice": tool_def("extract_invoice", "Record the data from a supplier invoice or a purchase order: both "
                                "carry payment terms.", extraction_schema("invoice")),
    "extract_receipt": tool_def("extract_receipt", "Record the data from a till or shop receipt: paid at the counter, so "
                                "no payment terms.", extraction_schema("receipt")),
    "extract_metadata": tool_def("extract_metadata", "Record only the document's type, vendor and date. A cheap first "
                                 "step that later steps build on.", METADATA_SCHEMA),
}

RULES = """Rules:
- Copy values as printed. Never guess. When the document does not say, use null. Do not write "N/A" or invent a value.
- Use "unclear" where the document is ambiguous (a bare $ sign, a purchase whose category cannot be told).
- Dates are YYYY-MM-DD. A date such as 03/06/2026 is day first (3 June). Amounts are plain numbers: no symbols, a
  decimal point (convert 67,58 to 67.58).
- Add up the line items yourself in calculated_total. If it differs from the total printed on the document, set
  conflict_detected to true and leave stated_total as printed. Never correct the document to make it add up.
- Give each field a confidence from 0 to 1: your honest chance that the value is right. Use low numbers when unsure.
- Payment terms that point to a contract or agreement you cannot see are null."""

BASE_SYSTEM = ("You extract structured data from business documents for an accounts system. Call the extraction tool "
               "once with what the document says.\n\n" + RULES)


def system_prompt(few_shot: bool) -> str:
    if not few_shot:
        return BASE_SYSTEM
    shots = "\n\n".join(f"<example>\n<document>\n{e['text'].strip()}\n</document>\n<extraction>\n"
                        f"{json.dumps(e['extraction'], indent=1)}\n</extraction>\n</example>" for e in EXAMPLES)
    return BASE_SYSTEM + "\n\nWorked examples of different layouts:\n\n" + shots


def build_prompt(text: str) -> str:
    return f"<document>\n{text}\n</document>"


# ----- validation: semantics in code, not in the prompt -----

DATE_RE = re.compile(r"\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|"
                     r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b", re.I)
TERMS_RE = re.compile(r"\bnet\s*\d+|\b\d+\s*days?\b|\bwithin\s+\d+|\bpayment on delivery", re.I)
ATTACHMENT_RE = re.compile(r"attached\s+(\w+\s+)?(contract|agreement)|see\s+(the\s+)?(attached\s+)?(contract|agreement)|"
                           r"as per (the )?(attached )?(\w+\s+)?contract", re.I)
CURRENCY_RE = re.compile(r"£|€|\bGBP\b|\bEUR\b|\bUSD\b|US\$")


def parse_iso_date(value: Any) -> date | None:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return parsed if 2000 <= parsed.year <= 2100 else None


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def issue(field: str, kind: str, message: str) -> dict[str, str]:
    return {"field": field, "kind": kind, "message": message}


def validate(ex: dict[str, Any], doc_type: str) -> list[dict[str, str]]:
    """Checks an extraction the schema cannot: dates parse, amounts are numbers, the lines sum to the total, the
    currency is one we post. Kinds: format and arithmetic (the model can fix), missing (maybe not fixable), conflict and
    unsupported (a person decides)."""
    found: list[dict[str, str]] = []
    if not isinstance(ex.get("vendor"), str) or not ex["vendor"].strip():
        found.append(issue("vendor", "missing", "vendor is empty."))
    d = ex.get("date")
    if d is None:
        found.append(issue("date", "missing", "date is null, but the accounts system needs one."))
    elif parse_iso_date(d) is None:
        found.append(issue("date", "format", f"date {d!r} is not a real date written as YYYY-MM-DD."))
    cur = ex.get("currency")
    if cur is None:
        found.append(issue("currency", "missing", "currency is null, but the accounts system needs one."))
    elif cur == "unclear":
        found.append(issue("currency", "missing", "currency is 'unclear': the document does not say which currency."))
    elif cur not in CURRENCIES:
        found.append(issue("currency", "format", f"currency {cur!r} is not one of {', '.join(CURRENCIES)}."))
    elif cur not in KNOWN_CURRENCIES:
        found.append(issue("currency", "unsupported", f"currency {cur!r} is not one the accounts system posts."))
    stated = ex.get("stated_total")
    if stated is None:
        found.append(issue("stated_total", "missing", "stated_total is null."))
    elif not _number(stated) or stated < 0:
        found.append(issue("stated_total", "format", f"stated_total {stated!r} must be a plain non-negative JSON number "
                                                      "with no currency symbol."))
    amounts = [li.get("amount") for li in ex.get("line_items") or [] if isinstance(li, dict)]
    if any(not _number(a) for a in amounts):
        found.append(issue("line_items", "format", "Every line item amount must be a plain JSON number."))
    elif amounts:
        lines = round(sum(amounts), 2)
        calc = ex.get("calculated_total")
        if not _number(calc) or abs(calc - lines) > TOLERANCE:
            found.append(issue("calculated_total", "arithmetic",
                               f"calculated_total is {calc!r} but the line items add up to {lines}."))
        if _number(stated):
            differs = abs(stated - lines) > TOLERANCE
            if differs and ex.get("conflict_detected"):
                found.append(issue("stated_total", "conflict", f"The line items add up to {lines} but the document states "
                                                               f"{stated}. Flagged for a person to settle."))
            elif differs:
                found.append(issue("stated_total", "arithmetic", f"stated_total {stated} differs from the line items' sum "
                                                                 f"{lines}, but conflict_detected is false."))
            elif ex.get("conflict_detected"):
                found.append(issue("conflict_detected", "arithmetic", "conflict_detected is true but the totals agree."))
    terms = ex.get("payment_terms_days")
    if doc_type in NEEDS_TERMS:
        if terms is None:
            kind = doc_type.replace("_", " ")
            found.append(issue("payment_terms_days", "missing", f"payment_terms_days is null, but it is required for "
                                                                f"{'an' if kind[:1] in 'aeiou' else 'a'} {kind}."))
        elif not isinstance(terms, int) or isinstance(terms, bool) or terms < 0:
            found.append(issue("payment_terms_days", "format", f"payment_terms_days {terms!r} must be a whole number of days."))
    return found


def evidence(field: str, text: str) -> tuple[bool, str]:
    """Whether the document could contain this field's value. When not, asking the model again cannot help."""
    if field == "payment_terms_days":
        if ATTACHMENT_RE.search(text):
            return False, "The document says the terms are in an attached contract, which was not provided."
        return (True, "") if TERMS_RE.search(text) else (False, "No payment terms are printed anywhere in the document.")
    if field == "date":
        return (True, "") if DATE_RE.search(text) else (False, "No date is printed anywhere in the document.")
    if field == "currency":
        if CURRENCY_RE.search(text):
            return True, ""
        return False, ("Only a bare $ sign appears, which could be several currencies." if "$" in text
                       else "No currency symbol or code is printed.")
    return True, ""


def retry_decision(issues: list[dict[str, str]], text: str) -> dict[str, Any]:
    """accept, retry (the model can fix these) or flag (it cannot: the information is not in the document, or a person
    must decide). Retrying an absent value only invites the model to invent one."""
    fixable, stuck = [], []
    for i in issues:
        if i["kind"] in ("format", "arithmetic"):
            fixable.append(i)
        elif i["kind"] == "missing":
            present, why = evidence(i["field"], text)
            (fixable if present else stuck).append(i if present else {**i, "why": why})
        else:
            stuck.append({**i, "why": "A person has to decide this." if i["kind"] == "conflict"
                          else "The accounts system does not post this."})
    if fixable:
        return {"action": "retry", "fixable": fixable, "stuck": stuck, "reason": f"{len(fixable)} problem(s) the model can fix."}
    if stuck:
        return {"action": "flag", "fixable": [], "stuck": stuck,
                "reason": "Retrying cannot help: " + " ".join(sorted({s["why"] for s in stuck}))}
    return {"action": "accept", "fixable": [], "stuck": [], "reason": "Every check passed."}


def retry_messages(text: str, extraction: dict[str, Any], problems: list[dict[str, str]]) -> list[dict[str, Any]]:
    """The follow-up request: the document, the failed extraction and the specific errors, in one message."""
    listed = "\n".join(f"- {p['message']}" for p in problems)
    return [{"role": "user", "content": (
        f"{build_prompt(text)}\n\nYour previous extraction:\n<previous_extraction>\n{json.dumps(extraction, indent=1)}\n"
        f"</previous_extraction>\n\nOur validator found these problems:\n{listed}\n\nCall the tool again with a corrected "
        "extraction. Change only what the errors require. If the document does not contain a value, use null: never "
        "invent one.")}]


def corrupt(ex: dict[str, Any]) -> dict[str, Any]:
    """A deliberately sloppy copy (day-first slashes, a currency symbol inside the total), to show the retry fix it."""
    bad = copy.deepcopy(ex)
    d = parse_iso_date(bad.get("date"))
    if d:
        bad["date"] = f"{d.day:02d}/{d.month:02d}/{d.year % 100:02d}"
    if _number(bad.get("stated_total")):
        bad["stated_total"] = f"£{bad['stated_total']:,.2f}"
    return bad


def issue_keys(issues: list[dict[str, str]]) -> set[tuple[str, str]]:
    return {(i["field"], i["kind"]) for i in issues}


# ----- scoring against ground truth -----

def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip().lower() in PLACEHOLDERS)


def field_match(field: str, got: Any, truth: Any) -> bool:
    if blank(got):
        got = None
    if truth is None or got is None:
        return truth is None and got is None
    try:
        if field == "stated_total":
            return abs(float(got) - float(truth)) < 0.005
        if field == "payment_terms_days":
            return int(got) == int(truth)
    except (TypeError, ValueError):
        return False
    if field in ("date", "currency", "category"):
        return str(got).strip() == truth
    return _norm(got) == _norm(truth)


def is_empty(field: str, got: Any) -> bool:
    return blank(got) or (field in ("currency", "category") and got == "unclear")


def score(doc: dict[str, Any], ex: dict[str, Any] | None) -> dict[str, Any]:
    """Each scored field against the truth. 'empty' means the truth has a value and the model returned null, a
    placeholder or 'unclear': the failure the few-shot examples are meant to cure."""
    ex = ex or {}
    conf = ex.get("confidence") if isinstance(ex.get("confidence"), dict) else {}
    fields: dict[str, Any] = {}
    for f in FIELDS:
        truth, got = doc["truth"][f], ex.get(f)
        ok = field_match(f, got, truth)
        c = conf.get(f)
        fields[f] = {"truth": truth, "got": got, "correct": ok,
                     "empty": (not ok) and truth is not None and is_empty(f, got),
                     "confidence": float(c) if _number(c) else None}
    return {"fields": fields, "conflict_correct": bool(ex.get("conflict_detected")) == doc["conflict"] if ex else False}


def summarise(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Accuracy overall, by document type and by field, plus the weak spots a single overall figure hides."""
    n_fields = sum(len(r["fields"]) for r in results) or 1
    correct = sum(f["correct"] for r in results for f in r["fields"].values())
    by_type: dict[str, list[int]] = {}
    by_field: dict[str, list[int]] = {}
    for r in results:
        for name, f in r["fields"].items():
            by_type.setdefault(r["type"], []).append(f["correct"])
            by_field.setdefault(name, []).append(f["correct"])
    rate = lambda xs: round(sum(xs) / len(xs), 4)  # noqa: E731
    overall = round(correct / n_fields, 4)
    types = {k: {"accuracy": rate(v), "n": len(v)} for k, v in sorted(by_type.items())}
    fields = {k: {"accuracy": rate(v), "n": len(v)} for k, v in by_field.items()}
    weak = [{"kind": kind, "name": k, "accuracy": v["accuracy"]} for kind, group in (("type", types), ("field", fields))
            for k, v in group.items() if v["accuracy"] < overall - 0.08]
    lat = sorted(r["latency_s"] for r in results if r.get("latency_s") is not None)
    cost = round(sum(r.get("cost_usd") or 0 for r in results), 6)
    return {"docs": len(results), "overall": overall, "by_type": types, "by_field": fields,
            "weak_spots": sorted(weak, key=lambda w: w["accuracy"]),
            "empties": sum(f["empty"] for r in results for f in r["fields"].values()),
            "conflicts_right": sum(1 for r in results if r.get("conflict_correct")),
            "docs_perfect": sum(all(f["correct"] for f in r["fields"].values()) for r in results),
            "latency_mean_s": round(sum(lat) / len(lat), 3) if lat else None,
            "latency_p95_s": lat[min(len(lat) - 1, int(0.95 * len(lat)))] if lat else None,
            "cost_usd": cost, "cost_per_doc_usd": round(cost / len(results), 6) if results else 0.0}


# ----- confidence: calibration, a review threshold, a stratified spot check -----

BANDS = [(0.0, 0.5), (0.5, 0.7), (0.7, 0.85), (0.85, 0.95), (0.95, 1.0001)]


def band_label(lo: float, hi: float) -> str:
    return f"{lo:.2f} to {min(hi, 1.0):.2f}"


def calibration(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Accuracy per confidence band. items: {confidence, correct}. A calibrated model's accuracy sits near its band."""
    out = []
    for lo, hi in BANDS:
        inside = [i for i in items if i["confidence"] is not None and lo <= i["confidence"] < hi]
        out.append({"band": band_label(lo, hi), "lo": lo, "hi": min(hi, 1.0), "n": len(inside),
                    "accuracy": round(sum(i["correct"] for i in inside) / len(inside), 4) if inside else None,
                    "mean_confidence": round(sum(i["confidence"] for i in inside) / len(inside), 4) if inside else None})
    return out


def pick_threshold(items: list[dict[str, Any]], target: float) -> dict[str, Any]:
    """The lowest confidence at or above which accuracy reaches the target, so the most fields skip review."""
    scored = [i for i in items if i["confidence"] is not None]
    for t in sorted({i["confidence"] for i in scored}):
        above = [i for i in scored if i["confidence"] >= t]
        acc = sum(i["correct"] for i in above) / len(above)
        if acc >= target and len(above) >= 5:
            return {"threshold": t, "accuracy_above": round(acc, 4), "coverage": round(len(above) / len(scored), 4),
                    "reached": True}
    return {"threshold": 1.0001, "accuracy_above": None, "coverage": 0.0, "reached": False}


def route(result: dict[str, Any], threshold: float) -> dict[str, Any]:
    """Auto-accept or send to a person. Anything under the threshold, any failed check or a flagged conflict goes."""
    reasons = [f"{n} confidence {f['confidence']:.2f}" for n, f in result["fields"].items()
               if f["confidence"] is None or f["confidence"] < threshold]
    reasons += [f"check: {i['message']}" for i in result.get("issues", [])]
    if result.get("extraction") is None:
        reasons.append("no extraction")
    return {"review": bool(reasons), "reasons": reasons}


def stratified_sample(items: list[dict[str, Any]], key: str, per_stratum: int, seed: int) -> list[dict[str, Any]]:
    """A seeded random sample with the same number from every stratum, so a rare document type is not drowned out."""
    rng = random.Random(seed)
    strata: dict[Any, list[dict[str, Any]]] = {}
    for item in sorted(items, key=lambda i: i["doc_id"]):
        strata.setdefault(item[key], []).append(item)
    out: list[dict[str, Any]] = []
    for name in sorted(strata, key=str):
        pool = strata[name]
        out += rng.sample(pool, min(per_stratum, len(pool)))
    return out


def analyse(results: list[dict[str, Any]], target: float, seed: int, per_stratum: int) -> dict[str, Any]:
    """Calibrate on the validation split, set a threshold, apply it to the test split and sample the auto-accepted."""
    val = [r for r in results if r["split"] == "validation"]
    test = [r for r in results if r["split"] == "test"]
    items = [{"confidence": f["confidence"], "correct": f["correct"]} for r in val for f in r["fields"].values()]
    chosen = pick_threshold(items, target)
    routed = [(r, route(r, chosen["threshold"])) for r in test]
    auto = [r for r, rt in routed if not rt["review"]]
    auto_fields = [f["correct"] for r in auto for f in r["fields"].values()]
    sample = stratified_sample([{"doc_id": r["doc_id"], "type": r["type"], "confidence_min": min(
        (f["confidence"] for f in r["fields"].values() if f["confidence"] is not None), default=None)} for r in auto],
        "type", per_stratum, seed)
    return {"target": target, "seed": seed, "validation_docs": len(val), "test_docs": len(test),
            "calibration": calibration(items), "threshold": chosen,
            "test": {"auto": len(auto), "review": len(test) - len(auto),
                     "auto_accuracy": round(sum(auto_fields) / len(auto_fields), 4) if auto_fields else None,
                     "all_accuracy": summarise(test)["overall"] if test else None,
                     "routing": [{"doc_id": r["doc_id"], "type": r["type"], **rt} for r, rt in routed]},
            "spot_check": sample, "overall": summarise(results)}


# ----- the A/B comparison -----

def compare_runs(a: dict[str, Any], b: dict[str, Any], limit: int = 40) -> dict[str, Any]:
    """Run B against run A on the same labelled set: accuracy by field and type, latency, cost, and which fields changed."""
    sa, sb = a["summary"], b["summary"]
    diff = lambda g: {k: {"a": sa[g][k]["accuracy"], "b": sb[g].get(k, {}).get("accuracy"),  # noqa: E731
                          "delta": round((sb[g].get(k, {}).get("accuracy") or 0) - sa[g][k]["accuracy"], 4)} for k in sa[g]}
    ra = {r["doc_id"]: r for r in a["results"]}
    regress, improve = [], []
    for r in b["results"]:
        other = ra.get(r["doc_id"])
        if not other:
            continue
        for f, fb in r["fields"].items():
            fa = other["fields"][f]
            row = {"doc_id": r["doc_id"], "field": f, "truth": fb["truth"], "a": fa["got"], "b": fb["got"]}
            if fa["correct"] and not fb["correct"]:
                regress.append(row)
            elif fb["correct"] and not fa["correct"]:
                improve.append(row)
    n = max(sb["docs"] * len(FIELDS), 1)
    right_a, right_b = sa["overall"] * n, sb["overall"] * n
    return {"a": {"run_id": a["run_id"], "model": a["model"], "few_shot": a["few_shot"], "summary": sa},
            "b": {"run_id": b["run_id"], "model": b["model"], "few_shot": b["few_shot"], "summary": sb},
            "overall_delta": round(sb["overall"] - sa["overall"], 4), "by_field": diff("by_field"), "by_type": diff("by_type"),
            "regressions": regress[:limit], "improvements": improve[:limit],
            "cost_per_1000_docs": {"a": round(sa["cost_per_doc_usd"] * 1000, 2), "b": round(sb["cost_per_doc_usd"] * 1000, 2)},
            "cost_per_correct_field": {"a": round(sa["cost_usd"] / right_a, 6) if right_a else None,
                                       "b": round(sb["cost_usd"] / right_b, 6) if right_b else None}}


# ----- batches: custom_id matching and resubmission -----

def chunk_document(text: str, body_lines: int = 12, head: int = 6, tail: int = 3) -> list[str]:
    """Splits a long table into pieces that each fit one output: the header repeats, the footer stays with the last."""
    lines = text.split("\n")
    top, bottom, body = lines[:head], lines[-tail:], lines[head:-tail]
    pieces = [body[i:i + body_lines] for i in range(0, len(body), body_lines)] or [[]]
    return ["\n".join(top + p + (bottom if i == len(pieces) - 1 else [])) for i, p in enumerate(pieces)]


def merge_chunks(parts: list[dict[str, Any]]) -> dict[str, Any]:
    """One extraction from the chunks, in order: every line item, header fields from whichever chunk has them."""
    merged: dict[str, Any] = {}
    for key in parts[0]:
        if key in ("line_items", "confidence", "calculated_total", "conflict_detected"):
            continue
        merged[key] = next((p.get(key) for p in reversed(parts) if p.get(key) is not None), None)
    lines = [li for p in parts for li in p.get("line_items") or []]
    merged["line_items"] = lines
    merged["calculated_total"] = round(sum(li["amount"] for li in lines if _number(li.get("amount"))), 2)
    stated = merged.get("stated_total")
    merged["conflict_detected"] = bool(_number(stated) and abs(stated - merged["calculated_total"]) > TOLERANCE)
    merged["confidence"] = {k: min((p["confidence"].get(k, 1) for p in parts if isinstance(p.get("confidence"), dict)),
                                   default=None) for k in (parts[0].get("confidence") or {})}
    return merged


# Batch custom ids may only hold letters, digits, "_" and "-". Document ids never contain "_", so a chunk is "po-07__1".
CHUNK_SEP = "__"


def chunk_custom_id(doc_id: str, index: int) -> str:
    return f"{doc_id}{CHUNK_SEP}{index}"


def split_custom_id(custom_id: str) -> tuple[str, int | None]:
    doc, _, idx = custom_id.partition(CHUNK_SEP)
    return doc, int(idx) if idx.isdigit() else None


def tool_input(message: Any, name: str = "extract_document") -> dict[str, Any] | None:
    for block in message.content:
        if block.type == "tool_use" and block.name == name:
            return dict(block.input)
    return None


def match_results(results: list[dict[str, Any]], custom_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Results arrive in any order: match each to its request by custom_id. A request with no result is 'missing'."""
    got = {r["custom_id"]: r for r in results}
    out: dict[str, dict[str, Any]] = {}
    for cid in custom_ids:
        r = got.get(cid)
        if r is None:
            out[cid] = {"status": "failed", "reason": "missing", "detail": "No result came back for this request."}
        elif r["type"] == "succeeded":
            m = r["message"]
            if m.stop_reason == "max_tokens":
                out[cid] = {"status": "failed", "reason": "max_tokens", "detail": "The output hit the token limit and was cut off."}
            elif m.stop_reason == "refusal":
                out[cid] = {"status": "failed", "reason": "refusal", "detail": "The model declined."}
            elif (ex := tool_input(m)) is None:
                out[cid] = {"status": "failed", "reason": "no_tool_call", "detail": "The reply had no tool call."}
            else:
                out[cid] = {"status": "ok", "extraction": ex, "usage": m.usage, "model": m.model}
        elif r["type"] == "errored":
            out[cid] = {"status": "failed", "reason": r.get("error_type") or "error", "detail": r.get("error_message", "")}
        else:
            out[cid] = {"status": "failed", "reason": r["type"], "detail": f"The request was {r['type']}."}
    return out


def resubmit_plan(outcomes: dict[str, dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    """Which failed documents to send again, and how. Cut-off output means split the document; a transient error means
    send it unchanged; an invalid request or a refusal would only fail again, so a person looks at it first."""
    again: list[dict[str, str]] = []
    held: list[dict[str, str]] = []
    for doc_id, o in outcomes.items():
        if o["status"] in ("ok", "resubmitted"):  # resubmitted: already in flight in a later batch
            continue
        row = {"doc_id": doc_id, "reason": o["reason"], "detail": o.get("detail", "")}
        if o["reason"] in ("invalid_request_error", "refusal"):
            held.append(row)
        else:
            again.append({**row, "action": "chunk" if o["reason"] == "max_tokens" else "resend"})
    return {"resubmit": again, "held": held}
