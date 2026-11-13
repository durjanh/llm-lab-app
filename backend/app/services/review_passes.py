"""The review-passes lab: how the way you ask for a code review changes what comes back.

A model reviews an invented change set (a refunds feature, five files in `review_passes_code.py`) that has six real
problems, some harmless style noise and a few local patterns that are fine. The answer key is here. Each mode runs the
reviews it compares, and code scores every finding against the key: found, missed, false positives, precision, tokens
and cost. The key finds each place by a snippet of text, not a line number, and counts a finding that lands within a
line of the place.

Findings come back as structured output, in the schema of examples/claude-code/ci/review-schema.json (plus a
confidence for the confidence mode), so a CI job could read them.
"""
from __future__ import annotations

import json
from typing import Any

from ..core.errors import to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, text_of
from .review_passes_code import FILES, FIXED_STORE, numbered
from .spend import SpendTracker

SLACK = 1  # a finding this many lines either side of a place still counts as pointing at it
HIGH, MEDIUM = 0.8, 0.5  # confidence routing: at or above HIGH comment on the PR; at or above MEDIUM ask a person

# Where each thing lives: (file, a snippet that starts the place, extra lines the place covers).
Place = tuple[str, str, int]

KEY: list[dict[str, Any]] = [
    {"id": "units", "severity": "bug", "cross_file": True,
     "what": "refund_amount() returns pounds (a float such as 18.0) and issue_refund() stores it as amount_pence, so "
             "the provider is asked to refund 18 pence instead of 1,800. Each file looks right on its own.",
     "places": [("refunds/policy.py", "def refund_amount", 0), ("refunds/policy.py", "return round(paid, 2)", 2),
                ("refunds/service.py", "request = RefundRequest(", 0)]},
    {"id": "sql", "severity": "security", "cross_file": False,
     "what": "find_by_customer() builds its SQL with an f-string from a value that comes from the support form: "
             "SQL injection.",
     "places": [("refunds/store.py", "WHERE o.customer_ref = '{customer_ref}'", 1)]},
    {"id": "delete_first", "severity": "data-loss", "cross_file": False,
     "what": "issue_refund() deletes the pending request before the provider call. If the call fails, the request is "
             "gone and nothing records that the customer is owed a refund.",
     "places": [("refunds/service.py", "self.store.delete_pending(order.id)", 4),
                ("refunds/store.py", "def delete_pending", 3)]},
    {"id": "window", "severity": "bug", "cross_file": False,
     "what": "The docstring says the window includes the 30th day, but `< REFUND_WINDOW_DAYS` refuses day 30.",
     "places": [("refunds/policy.py", "def within_window", 2)]},
    {"id": "overrefund", "severity": "bug", "cross_file": False,
     "what": "`already` (what has been refunded) is read and never used, so a second refund can take the total above "
             "what the customer paid.",
     "places": [("refunds/service.py", "already = self.store", 2)]},
    {"id": "retry", "severity": "bug", "cross_file": False,
     "what": "A refund that times out is sent again with no idempotency key. The provider may have processed the first "
             "one, so a retry can refund twice.",
     "places": [("refunds/gateway.py", "for attempt in range", 8)]},
]

# Things that look wrong and are not worth a finding: style noise, and local patterns that are acceptable here.
NOISE: list[dict[str, Any]] = [
    {"id": "unused_import", "kind": "style", "what": "An unused import (Optional).",
     "places": [("refunds/models.py", "from typing import Optional", 0)]},
    {"id": "long_line", "kind": "style", "what": "A line over 120 characters in RefundStore.add.",
     "places": [("refunds/store.py", "(request.order_id, request.amount_pence", 0)]},
    {"id": "todo", "kind": "style", "what": "A TODO comment about paging.",
     "places": [("refunds/store.py", "# TODO: page this", 1)]},
    {"id": "naming", "kind": "style", "what": "A misspelt local name, ordr_total_gbp.",
     "places": [("refunds/service.py", "ordr_total_gbp = ", 0)]},
    {"id": "assert", "kind": "local pattern", "what": "An assert for an internal invariant, which the order feed keeps.",
     "places": [("refunds/policy.py", "assert paid > 0", 0)]},
    {"id": "global", "kind": "local pattern", "what": "A module-level orders dictionary filled at start-up.",
     "places": [("refunds/service.py", "_ORDERS: dict", 0)]},
    {"id": "broad_except", "kind": "local pattern",
     "what": "A broad except at the edge that logs and answers calmly, as an HTTP handler should.",
     "places": [("refunds/service.py", "except Exception:", 2)]},
]

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"findings": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "file": {"type": "string"},
            "line": {"type": "integer"},
            "severity": {"type": "string", "enum": ["bug", "security", "data-loss"]},
            "issue": {"type": "string", "description": "What is wrong, in one or two sentences"},
            "suggested_fix": {"type": "string"},
            "detected_pattern": {"type": "string",
                                 "description": "The code construct that triggered the finding, for tracking dismissals"},
            "status": {"type": "string", "enum": ["new", "still_open"]},
        },
        "required": ["file", "line", "severity", "issue", "status"],
        "additionalProperties": False}}},
    "required": ["findings"],
    "additionalProperties": False,
}  # the same as examples/claude-code/ci/review-schema.json; a test checks it


def findings_schema(*, status: bool = False, confidence: bool = False) -> dict[str, Any]:
    """The CI schema, without `status` unless a re-run needs it, and with `confidence` when asked."""
    schema = json.loads(json.dumps(SCHEMA))
    item = schema["properties"]["findings"]["items"]
    if not status:
        del item["properties"]["status"]
        item["required"].remove("status")
        item["required"].append("detected_pattern")
    if confidence:
        item["properties"]["confidence"] = {"type": "number", "description": "Your honest chance, 0 to 1, that a "
                                            "maintainer would agree this is a real problem"}
        item["required"].append("confidence")
    return schema


VAGUE = "You are a code reviewer. Check the code carefully, be conservative, and only report high-confidence findings."

EXPLICIT = """You are reviewing a change set for a pull request. Report only these three kinds of problem:

- bug: the code does the wrong thing for valid input. Example: `total = price * qty - discount` where discount is a
  percentage, so a 10% discount takes 10 pounds off.
- security: someone could read, change or run what they should not. Example: `os.system("ping " + host)` where host
  comes from a web form.
- data-loss: data is lost, overwritten or left inconsistent when something fails. Example: `os.remove(path)` before the
  replacement file has been written.

Do not report style, naming, unused imports, long lines, TODO comments or missing docstrings. Do not report patterns
that are acceptable locally: a module-level cache or table filled at start-up, an assert for an internal invariant, and
a broad except at a request boundary that logs the error and answers calmly.

Report each problem once, at the line of the faulty code, and say how to fix it. Point only at lines you can see.
For detected_pattern, name the code construct that made you report it (for example "f-string in SQL")."""

PASS_ONE_FILE = """

You can see one file only. Report only problems that are visible in this file on its own, and do not guess how code in
other files behaves."""

PASS_INTEGRATION = """

Each file has already been reviewed on its own. Your job is the problems that only show across files: a value that one
file produces and another file uses wrongly (units, types, meaning, ordering), or a call that breaks the promise of the
function it calls. Read the docstrings and names of what each file produces, then check how the other files use it.
Report each at the line where the value is used wrongly. Do not repeat problems that are inside one file."""

CI_RERUN = """

This is a re-run on an updated change set. The findings from the last run are below. For each one: if the code it
points at still has the problem, report it again with status "still_open" (use the file's current line number); if it
has been fixed, leave it out. Report anything new that was not in the last run with status "new"."""


def locate(place: Place) -> tuple[str, int, int]:
    """(file, first line, last line) of a place in the change set."""
    name, snippet, extra = place
    for i, line in enumerate(FILES[name].splitlines(), 1):
        if snippet in line:
            return name, i, i + extra
    raise ValueError(f"{snippet!r} is not in {name}")


def _inside(finding: dict[str, Any], places: list[Place]) -> bool:
    name = str(finding.get("file", "")).strip().lstrip("./")
    try:
        line = int(finding.get("line", -99))
    except (TypeError, ValueError):
        return False
    for place in places:
        f, first, last = locate(place)
        if name.endswith(f) and first - SLACK <= line <= last + SLACK:
            return True
    return False


def score(findings: list[dict[str, Any]], files: dict[str, str] | None = None) -> dict[str, Any]:
    """Each finding against the key. A finding matches a real problem, matches noise, repeats a problem already
    found, or matches nothing (not in the key: possibly real, but not one the key knows)."""
    seen: set[str] = set()
    rows = []
    for f in findings:
        real = next((k["id"] for k in KEY if _inside(f, k["places"])), None)
        noise = None if real else next((n for n in NOISE if _inside(f, n["places"])), None)
        if real and real in seen:
            verdict, ref = "duplicate", real
        elif real:
            seen.add(real)
            verdict, ref = "found", real
        elif noise:
            verdict, ref = "noise", f"{noise['kind']}: {noise['what']}"
        else:
            verdict, ref = "not in key", ""
        rows.append({**f, "verdict": verdict, "matches": ref})
    found = [k["id"] for k in KEY if k["id"] in seen]
    false_pos = sum(r["verdict"] in ("noise", "not in key") for r in rows)
    distinct = len(found) + false_pos
    return {"findings": rows, "found": found, "missed": [k["id"] for k in KEY if k["id"] not in seen],
            "false_positives": false_pos, "noise_hits": sum(r["verdict"] == "noise" for r in rows),
            "duplicates": sum(r["verdict"] == "duplicate" for r in rows),
            "precision": round(len(found) / distinct, 2) if distinct else None,
            "recall": round(len(found) / len(KEY), 2)}


FIXED_BY_CHANGE = ("sql",)  # what FIXED_STORE repairs: run 2 should not report it


def contradictions(findings: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Pairs of findings about the same problem that disagree on how serious it is. Passes that cannot see each
    other's work produce these: the same fault, called a bug by one and a security problem by another."""
    def problem(f: dict[str, Any]) -> str | None:
        return next((k["id"] for k in KEY if _inside(f, k["places"])), None)

    out = []
    for i, a in enumerate(findings):
        for b in findings[i + 1:]:
            # Two different real problems a line apart are not a contradiction: the same problem is. Findings the key
            # does not know count as the same problem only on the same line.
            try:
                pa, pb = problem(a), problem(b)
                same = (pa is not None and pa == pb) or (
                    pa is None and pb is None and a["file"] == b["file"] and int(a["line"]) == int(b["line"]))
            except (KeyError, TypeError, ValueError):
                continue
            if same and a.get("severity") != b.get("severity"):
                out.append({"file": a["file"], "a": f"{a.get('severity')}: {a.get('issue', '')}",
                            "b": f"{b.get('severity')}: {b.get('issue', '')}"})
    return out


def route(findings: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Where a finding goes by its own confidence: comment on the pull request, ask a person, or just log it."""
    lanes: dict[str, list[dict[str, Any]]] = {"comment": [], "triage": [], "log": []}
    for f in findings:
        c = float(f.get("confidence") or 0)
        lanes["comment" if c >= HIGH else "triage" if c >= MEDIUM else "log"].append(f)
    return lanes


def dismissed_patterns(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The findings the key does not support, grouped by the construct that triggered them. A pattern that shows
    up again and again is a rule to tighten in the criteria."""
    counts: dict[str, int] = {}
    for r in rows:
        if r["verdict"] in ("noise", "not in key"):
            key = str(r.get("detected_pattern") or "(none given)").strip().lower()
            counts[key] = counts.get(key, 0) + 1
    return [{"pattern": p, "count": n} for p, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


class Tally:
    """Tokens, cost and calls for one variant."""

    def __init__(self) -> None:
        self.tokens_in = self.tokens_out = self.calls = 0
        self.cost = 0.0

    def add(self, response: Any, cost: float | None) -> None:
        usage = response.usage
        self.tokens_in += int(getattr(usage, "input_tokens", 0) or 0)
        self.tokens_out += int(getattr(usage, "output_tokens", 0) or 0)
        self.cost += cost or 0.0
        self.calls += 1

    def report(self) -> dict[str, Any]:
        return {"tokens_in": self.tokens_in, "tokens_out": self.tokens_out, "calls": self.calls,
                "cost_usd": round(self.cost, 6)}


def parse(raw: str) -> list[dict[str, Any]]:
    try:
        found = json.loads(raw).get("findings", [])
    except (ValueError, AttributeError):
        return []
    return [f for f in found if isinstance(f, dict)]


class ReviewPassesService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker):
        self.claude, self.spend = claude, spend

    def info(self) -> dict[str, Any]:
        """The change set (numbered), the answer key and the prompts, for the page to show."""
        return {
            "files": [{"name": n, "code": body, "lines": len(body.splitlines())} for n, body in FILES.items()],
            "key": [{"id": k["id"], "severity": k["severity"], "cross_file": k["cross_file"], "what": k["what"],
                     "where": [f"{f}:{a}" for f, a, _ in (locate(p) for p in k["places"])]} for k in KEY],
            "noise": [{"id": n["id"], "kind": n["kind"], "what": n["what"]} for n in NOISE],
            "prompts": {"vague": VAGUE, "explicit": EXPLICIT},
            "thresholds": {"comment": HIGH, "triage": MEDIUM},
            "schema": findings_schema(status=True),
        }

    # -- one model call ---------------------------------------------------------------------------------------

    def _ask(self, tally: Tally, model: str, system: str, messages: list[dict[str, Any]],
             schema: dict[str, Any] | None, max_tokens: int = 4000) -> str:
        params: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "system": system, "messages": messages}
        if schema:
            params["output_config"] = {"format": {"type": "json_schema", "schema": schema}}
        try:
            response = self.claude.create(**params)
        except Exception as exc:
            raise to_api_error(exc) from exc
        tally.add(response, self.spend.charge(response, model))
        return text_of(response)

    def _review(self, tally: Tally, model: str, system: str, files: dict[str, str], schema: dict[str, Any],
                extra: str = "") -> list[dict[str, Any]]:
        prompt = f"Review this change set.\n\n{numbered(files)}{extra}"
        return parse(self._ask(tally, model, system, [{"role": "user", "content": prompt}], schema))

    def _variant(self, name: str, about: str, findings: list[dict[str, Any]], tally: Tally, model: str,
                 **extra: Any) -> dict[str, Any]:
        return {"name": name, "about": about, "model": model, **score(findings), **tally.report(), **extra}

    # -- 1. criteria -----------------------------------------------------------------------------------------

    def criteria(self, model: str | None) -> dict[str, Any]:
        model = model or DEFAULT_MODEL
        schema = findings_schema()
        out = []
        for name, about, system in (("Vague criteria", "Check carefully, be conservative, high-confidence only.", VAGUE),
                                    ("Explicit criteria", "Bugs, security and data loss; skip style and local patterns; "
                                     "severities defined with an example each.", EXPLICIT)):
            tally = Tally()
            out.append(self._variant(name, about, self._review(tally, model, system, FILES, schema), tally, model))
        return {"variants": out}

    # -- 2. passes -------------------------------------------------------------------------------------------

    def passes(self, model: str | None) -> dict[str, Any]:
        model = model or DEFAULT_MODEL
        schema = findings_schema()
        one = Tally()
        single = self._review(one, model, EXPLICIT, FILES, schema)
        split, tally, steps = [], Tally(), []
        for name, body in FILES.items():
            got = self._review(tally, model, EXPLICIT + PASS_ONE_FILE, {name: body}, schema)
            steps.append({"step": name, "findings": len(got)})
            split += got
        cross = self._review(tally, model, EXPLICIT + PASS_INTEGRATION, FILES, schema)
        steps.append({"step": "integration pass (all files, data flow only)", "findings": len(cross)})
        split += cross
        return {"variants": [
            self._variant("One pass, all files", "One call sees all five files and reports everything.", single, one,
                          model, contradictions=contradictions(single), steps=[{"step": "all files", "findings": len(single)}]),
            self._variant("Per-file passes plus an integration pass", "Five calls review one file each; a sixth "
                          "reads all of them for values that cross a file boundary.", split, tally, model,
                          contradictions=contradictions(split), steps=steps)]}

    # -- 3. independent --------------------------------------------------------------------------------------

    def independent(self, model: str | None) -> dict[str, Any]:
        model = model or DEFAULT_MODEL
        schema = findings_schema()
        code = numbered(FILES)
        own = Tally()
        explain = [{"role": "user", "content": f"You wrote this change set for a refunds feature.\n\n{code}\n\n"
                    "Explain what it does and why each part is correct."}]
        explanation = self._ask(own, model, EXPLICIT, explain, None, 1500)
        asked = explain + [{"role": "assistant", "content": explanation},
                           {"role": "user", "content": "Now review it as a code reviewer would."}]
        mine = parse(self._ask(own, model, EXPLICIT, asked, schema))
        fresh = Tally()
        independent = self._review(fresh, model, EXPLICIT, FILES, schema)
        return {"variants": [
            self._variant("Self-review", "The conversation that explained the change in its own favour is asked to "
                          "review it.", mine, own, model, explanation=explanation),
            self._variant("Independent reviewer", "A new call with no history sees only the code and the criteria.",
                          independent, fresh, model)]}

    # -- 4. confidence ---------------------------------------------------------------------------------------

    def confidence(self, model: str | None) -> dict[str, Any]:
        model = model or DEFAULT_MODEL
        tally = Tally()
        system = EXPLICIT + ("\n\nAlso report anything you are unsure about, with a low confidence. Give every finding "
                             "a confidence from 0 to 1.")
        findings = self._review(tally, model, system, FILES, findings_schema(confidence=True))
        scored = score(findings)
        lanes = route(scored["findings"])
        routing = [{"lane": lane, "count": len(rows),
                    "real": sum(r["verdict"] == "found" for r in rows),
                    "dismissed": sum(r["verdict"] in ("noise", "not in key") for r in rows),
                    "findings": rows} for lane, rows in lanes.items()]
        return {"variant": self._variant("Findings with confidence", "Each finding says how sure it is and what "
                                         "construct triggered it.", findings, tally, model),
                "routing": routing, "dismissed_patterns": dismissed_patterns(scored["findings"])}

    # -- 5. ci -----------------------------------------------------------------------------------------------

    def ci(self, model: str | None) -> dict[str, Any]:
        model = model or DEFAULT_MODEL
        schema = findings_schema(status=True)
        first_tally = Tally()
        first = self._review(first_tally, model, EXPLICIT + '\n\nSet status to "new" on every finding.', FILES, schema)
        first_scored = score(first)
        updated = {**FILES, "refunds/store.py": FIXED_STORE}
        extra = CI_RERUN + "\n\nPrevious findings:\n" + json.dumps(first, indent=1)
        second_tally = Tally()
        second = self._review(second_tally, model, EXPLICIT, updated, schema, extra)
        second_scored = score(second)
        before = set(first_scored["found"])
        rows = []
        for r in second_scored["findings"]:
            expected = "still_open" if r["verdict"] in ("found", "duplicate") and r["matches"] in before else "new"
            rows.append({**r, "status_ok": r.get("status") == expected})
        second_scored["findings"] = rows
        return {"changed_file": "refunds/store.py",
                "first": self._variant("Run 1: every finding is new", "The whole change set.", first, first_tally, model),
                "second": {**(run2 := self._variant("Run 2: after the fix", "store.py now uses a parameterised query. "
                                                    "The run is given the first findings and reports new or still "
                                                    "open only.", second, second_tally, model)), "findings": rows,
                           # The fix removed the SQL problem, so not reporting it again is right, not a miss.
                           "missed": [m for m in run2["missed"] if m not in FIXED_BY_CHANGE],
                           "resolved_by_fix": list(FIXED_BY_CHANGE)},
                "fixed": [i for i in first_scored["found"] if i not in second_scored["found"]],
                "still_open": [i for i in first_scored["found"] if i in second_scored["found"]]}
