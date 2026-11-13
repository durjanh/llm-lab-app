"""Research team: a coordinator that delegates to specialised subagents and produces a cited report.

This is the Claude Certified Architect exam's Scenario 3, run on the Messages API with our own orchestration.
- Hub and spoke: only the coordinator talks to subagents. It reads the question, writes sub-questions, chooses which
  subagents to call, and after synthesis checks coverage and re-delegates with targeted queries (capped).
- Subagents start with an empty context. The coordinator names which earlier results to pass; the service writes them
  out in full in the subagent's prompt, and the page shows that exact prompt. Subagent definitions have the shape of
  the Agent SDK's AgentDefinition: description, prompt, tools.
- Each subagent has only its own tools. The synthesis agent can check a claim against the findings it was given, but
  cannot search.
- Failures are handled where they happen: a transient failure is retried inside the subagent; what it cannot resolve
  goes up as {failure_type, attempted_query, partial_results, alternatives}. An access failure is not an empty result.
- Findings are {claim, evidence, source id, title, publisher, date}. Code checks that the evidence is in the source and
  that every claim in the synthesis traces back to a finding.
- The run writes a manifest under generated/research-team/<run-id>/ so a crashed run resumes with only unfinished work.

The sources are an invented corpus about heat pumps in UK homes, so a run is cheap and repeatable.
"""
from __future__ import annotations

import contextvars
import json
import math
import re
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..core.errors import ApiError, describe, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, text_of
from .runs import Run, RunStreamer
from .spend import SpendTracker

MAX_COORDINATOR_TURNS = 14
MAX_SUBAGENT_TURNS = 8
MAX_REFINEMENTS = 2  # coverage re-delegations after the first synthesis
MAX_FETCH_RETRIES = 2  # a transient failure is retried this many times inside the subagent
MAX_TOKENS = 2400
RUN_ID = re.compile(r"^[0-9a-f]{12}$")

# ---------- the invented corpus ----------
# Heat pumps in UK homes. All publishers, figures and people are made up.

TRANSIENT_ID = "S10"  # the first fetch times out, the second works
BLOCKED_ID = "S11"  # always refused

SOURCES: list[dict[str, str]] = [
    {"id": "S01", "title": "Heat pump installations in Great Britain: 2024 annual figures",
     "publisher": "Kestrel Energy Research", "date": "2025-02-10",
     "abstract": "Annual count of heat pump installations, from installer certification records.",
     "text": "Kestrel counted 98,000 heat pump installations in Great Britain in 2024, up from 72,000 in 2023. "
             "Air-source units made up 94% of installations. The count uses installer certification records."},
    {"id": "S02", "title": "Heat Pump Market Tracker: full year 2024",
     "publisher": "Ridgeway Heating Federation", "date": "2025-03-04",
     "abstract": "Industry tracker of heat pump installations (units sold and fitted), from members and wholesalers.",
     "text": "Ridgeway members and wholesalers report 112,000 heat pumps sold and fitted in Great Britain in 2024. "
             "The federation expects sales to pass 150,000 in 2025 if the grant stays at its current level."},
    {"id": "S03", "title": "Installed cost of air-source heat pumps: 2022 quote survey",
     "publisher": "Kestrel Energy Research", "date": "2022-11-15",
     "abstract": "What installers quoted for air-source heat pumps in UK homes in 2022.",
     "text": "In 2022 the average installed cost of an air-source heat pump in a UK home was £13,000 before grants, "
             "based on 410 quotes. Installers cited scarce stock and too few trained fitters."},
    {"id": "S04", "title": "What households paid for a heat pump in early 2025",
     "publisher": "Fenwick Consumer Panel", "date": "2025-04-22",
     "abstract": "Invoice survey of households that fitted an air-source heat pump in the first quarter of 2025.",
     "text": "Households that fitted an air-source heat pump in the first quarter of 2025 paid an average of £11,200 "
             "before grants, from 312 invoices. Falling equipment prices and more competing installers were the "
             "main reasons given."},
    {"id": "S05", "title": "Field trial: seasonal performance of heat pumps in 600 homes",
     "publisher": "Northern Building Trials", "date": "2024-06-18",
     "abstract": "Measured seasonal efficiency of heat pumps across 600 occupied homes.",
     "text": "Across 600 homes the median seasonal coefficient of performance (SCOP) was 2.8: each unit of "
             "electricity produced 2.8 units of heat over the year. The best 10% of homes reached 3.4 and the "
             "worst 10% were below 2.2."},
    {"id": "S06", "title": "Boiler Upgrade Scheme: guidance for householders",
     "publisher": "Home Upgrade Grants Office", "date": "2025-01-09",
     "abstract": "Grant rules for replacing a fossil fuel boiler with a heat pump.",
     "text": "The Boiler Upgrade Scheme gives £7,500 towards an air-source or ground-source heat pump in England and "
             "Wales. The grant is paid to the installer and taken off the customer's invoice. The property needs a "
             "valid energy performance certificate with no outstanding loft or cavity wall insulation "
             "recommendations."},
    {"id": "S07", "title": "Running costs of heat pumps and gas boilers, winter 2024-25",
     "publisher": "Fenwick Consumer Panel", "date": "2025-04-30",
     "abstract": "Yearly heating bills compared for heat pump and gas boiler homes.",
     "text": "A typical three-bedroom semi-detached home with an air-source heat pump spent £980 a year on heating "
             "and hot water, against £1,150 for a gas boiler, at the April 2025 price cap. The gap narrows when a "
             "unit of electricity costs more than 3.5 times a unit of gas."},
    {"id": "S08", "title": "Permitted development rules for air-source heat pumps",
     "publisher": "Planning Practice Bureau", "date": "2024-09-02",
     "abstract": "When a heat pump needs planning permission, including noise limits.",
     "text": "An air-source heat pump can be installed without planning permission if its noise at the nearest "
             "neighbour's window is no more than 42 dB(A) and it sits at least 1 metre from the boundary. Listed "
             "buildings and conservation areas have extra rules."},
    {"id": "S09", "title": "Carbon savings from home heat pumps",
     "publisher": "Carbon Accounts Institute", "date": "2025-05-12",
     "abstract": "Lifetime carbon emissions of heat pumps compared with gas boilers.",
     "text": "Using the 2024 grid average, a heat pump with a SCOP of 2.8 emits about 65% less carbon than a gas "
             "boiler over its life. The saving grows as the grid gets cleaner."},
    {"id": "S10", "title": "Heat pump installer workforce survey, mid-2025",
     "publisher": "Tradecraft Council", "date": "2025-07-03",
     "abstract": "Number of certified heat pump installers and what limits training.",
     "text": "The Council estimates 4,300 certified heat pump installers were working in Great Britain in mid-2025, "
             "against 2,900 a year earlier. Employers say training places are the main limit."},
    {"id": "S11", "title": "House sale prices after retrofit: heat pump homes",
     "publisher": "Retrofit Outcomes Database", "date": "2025-03-28",
     "abstract": "Subscribers only. Sale-price effects of retrofit measures, including heat pumps.",
     "text": "Homes with heat pumps sold for 3.1% more than similar homes with gas boilers in the 2024 sample."},
    {"id": "S12", "title": "Heat pumps in older homes: a retrofit case study",
     "publisher": "Lowmoor Housing Association", "date": "2023-11-20",
     "abstract": "Heat pumps fitted in 48 homes built before 1930, and what insulation they needed.",
     "text": "Lowmoor fitted air-source heat pumps in 48 homes built before 1930. After loft and wall insulation, "
             "41 of the 48 homes stayed comfortable with larger radiators. Insulation cost an extra £3,400 per "
             "home on average."},
    {"id": "S13", "title": "Household satisfaction with heat pumps, 2025 panel",
     "publisher": "Fenwick Consumer Panel", "date": "2025-06-10",
     "abstract": "How satisfied households with a heat pump are, and what they complain about.",
     "text": "84% of 1,900 households with a heat pump said they would recommend one. The most common complaint, "
             "from 21%, was a slow response after the heating had been switched off."},
    {"id": "S14", "title": "Cold-weather performance: heat pumps below zero",
     "publisher": "Northern Building Trials", "date": "2025-01-27",
     "abstract": "Efficiency and output of heat pumps in freezing weather.",
     "text": "At an outdoor temperature of -5C the median instantaneous coefficient of performance was 2.2, against "
             "3.1 at 7C. Output stayed high enough to heat 96% of trial homes without backup heaters."},
]
SOURCES_BY_ID = {s["id"]: s for s in SOURCES}

QUESTIONS: list[dict[str, str]] = [
    {"id": "broad", "label": "Broad: is a heat pump a good choice?",
     "question": "Is a heat pump a good choice for a typical UK home? Cover cost, grants, efficiency, running costs "
                 "and carbon savings."},
    {"id": "narrow", "label": "Narrow: one fact",
     "question": "How much is the Boiler Upgrade Scheme grant for an air-source heat pump?"},
    {"id": "conflict", "label": "Two sources disagree",
     "question": "How many heat pumps were installed in Great Britain in 2024?"},
    {"id": "time", "label": "An old and a new figure",
     "question": "How much does an air-source heat pump cost to install, and has the price changed?"},
    {"id": "transient", "label": "A source times out once",
     "question": "How many certified heat pump installers are there in Great Britain?"},
    {"id": "blocked", "label": "A source refuses access",
     "question": "Do heat pumps change the sale price of a home? Also say what the grant is."},
    {"id": "empty", "label": "A valid empty result",
     "question": "What does the evidence say about hydrogen boilers as an alternative to heat pumps?"},
]

STOP_WORDS = {
    "a", "an", "the", "of", "in", "for", "to", "and", "or", "are", "is", "was", "were", "how", "many", "what", "much",
    "do", "does", "did", "on", "at", "by", "with", "about", "from", "uk", "gb", "great", "britain", "home", "house",
    "heat", "pump", "heating", "average", "typical", "there", "has", "have", "it", "that", "this", "any", "evidence",
}


def _tokens(text: str) -> list[str]:
    out = []
    for word in re.findall(r"[a-z0-9£][a-z0-9,.£]*", text.lower()):
        word = word.strip(".,")
        if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        if word:
            out.append(word)
    return out


def error_context(failure_type: str, attempted_query: str, partial_results: list[dict[str, Any]],
                  alternatives: list[dict[str, Any]], message: str = "") -> dict[str, Any]:
    """What a subagent sends up when it cannot resolve a failure itself. The coordinator decides what to do next."""
    return {"failure_type": failure_type, "attempted_query": attempted_query, "partial_results": partial_results,
            "alternatives": alternatives, "message": message}


class Corpus:
    """The sources, for one run. Fetching S10 times out once; fetching S11 is always refused."""

    def __init__(self, sources: list[dict[str, str]] | None = None) -> None:
        self.sources = {s["id"]: s for s in (sources if sources is not None else SOURCES)}
        self.attempts: dict[str, int] = {}
        self._lock = threading.Lock()

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        """Sources that match most of the query's content words. No match is a valid, empty result."""
        wanted = [t for t in dict.fromkeys(_tokens(query)) if t not in STOP_WORDS]
        scored = []
        if wanted:
            need = max(1, math.ceil(0.6 * len(wanted)))
            for s in self.sources.values():
                title, body = set(_tokens(s["title"])), set(_tokens(s["abstract"] + " " + s["text"]))
                hits = [t for t in wanted if t in title or t in body]
                if len(hits) >= need:
                    scored.append((len(hits) + sum(t in title for t in wanted), s))
        scored.sort(key=lambda p: (-p[0], p[1]["id"]))
        results = [{"source_id": s["id"], "title": s["title"], "publisher": s["publisher"], "date": s["date"],
                    "abstract": s["abstract"]} for _, s in scored[:max(1, limit)]]
        out: dict[str, Any] = {"query": query, "count": len(results), "results": results}
        if not results:
            out["note"] = "No source matched. This is a valid empty result: nothing in the corpus answers this query."
        return out

    def fetch(self, source_id: str) -> dict[str, Any]:
        """The full source, or {"error": {...}} with a failure type and whether trying again could help."""
        sid = source_id.strip().upper()
        with self._lock:
            self.attempts[sid] = self.attempts.get(sid, 0) + 1
            attempt = self.attempts[sid]
        source = self.sources.get(sid)
        if source is None:
            return {"error": {"failure_type": "not_found", "transient": False, "source_id": sid,
                              "message": f"No source {source_id!r}."}}
        if sid == BLOCKED_ID:
            return {"error": {"failure_type": "access_denied", "transient": False, "source_id": sid,
                              "message": "The publisher refused access (subscription required)."}}
        if sid == TRANSIENT_ID and attempt == 1:
            return {"error": {"failure_type": "timeout", "transient": True, "source_id": sid,
                              "message": "The request timed out. Trying again may work."}}
        return {"source": {k: source[k] for k in ("id", "title", "publisher", "date", "text")}}


# ---------- pure helpers: evidence, figures, provenance, coverage ----------

def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def evidence_in_source(evidence: str, source_id: str, corpus: dict[str, dict[str, str]] | None = None) -> bool:
    """True when the excerpt appears in the source's text (case and spacing ignored)."""
    source = (corpus or SOURCES_BY_ID).get(source_id)
    return bool(source and evidence.strip() and _norm(evidence) in _norm(source["text"]))


def _numbers(text: str) -> list[str]:
    return [n.replace(",", "").rstrip(".") for n in re.findall(r"\d[\d,]*\.?\d*", text)]


def attach_source(finding: dict[str, Any], corpus: dict[str, dict[str, str]] | None = None) -> dict[str, Any]:
    """A finding with its source's title, publisher and date filled in by code, never taken from the model."""
    s = (corpus or SOURCES_BY_ID)[finding["source_id"]]
    return {"claim": finding["claim"], "evidence": finding["evidence"], "source_id": s["id"], "title": s["title"],
            "publisher": s["publisher"], "date": s["date"], "sub_question": finding.get("sub_question", "")}


def classify_difference(a: dict[str, Any], b: dict[str, Any]) -> str:
    """Two figures for the same measure: agree, a time difference (different years), or a real conflict (same year)."""
    if abs(float(a["value"]) - float(b["value"])) < 1e-9:
        return "agree"
    return "time_difference" if int(a["year"]) != int(b["year"]) else "conflict"


def compare_figures(figures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Figures grouped by measure. Where two sources differ, the dates decide whether it is a conflict."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for f in figures:
        groups.setdefault(_norm(str(f.get("measure", ""))), []).append(f)
    out = []
    for measure, group in groups.items():
        by_source = list({f["source_id"]: f for f in group}.values())
        if len(by_source) < 2:
            continue
        by_source.sort(key=lambda f: (int(f["year"]), f["source_id"]))
        relations = {classify_difference(x, y) for i, x in enumerate(by_source) for y in by_source[i + 1:]}
        relation = "conflict" if "conflict" in relations else "time_difference" if "time_difference" in relations \
            else "agree"
        out.append({"measure": measure, "relation": relation, "sides": [
            {"source_id": f["source_id"], "value": f["value"], "unit": f.get("unit", ""), "year": int(f["year"])}
            for f in by_source]})
    return out


def check_provenance(findings: list[dict[str, Any]], synthesis: dict[str, Any]) -> list[dict[str, str]]:
    """Problems that break the claim-to-source mapping in a synthesis. An empty list means it holds."""
    by_source: dict[str, list[dict[str, Any]]] = {}
    for f in findings:
        by_source.setdefault(f["source_id"], []).append(f)
    issues: list[dict[str, str]] = []
    for c in synthesis.get("claims", []):
        text, ids = str(c.get("claim", "")), list(c.get("source_ids", []))
        if not ids:
            issues.append({"kind": "no_source", "claim": text, "detail": "The claim cites no source."})
            continue
        unknown = [i for i in ids if i not in by_source]
        for i in unknown:
            issues.append({"kind": "unknown_source", "claim": text, "detail": f"{i} is not in the findings."})
        known = [i for i in ids if i in by_source]
        if c.get("status") == "contested" and len(set(known)) < 2:
            issues.append({"kind": "contested_one_source", "claim": text,
                           "detail": "A contested claim must keep at least two sources side by side."})
        backing = " ".join(f["evidence"] + " " + f["claim"] + " " + f["date"][:4]
                           for i in known for f in by_source[i])
        have = set(_numbers(backing))
        missing = [n for n in _numbers(text) if n not in have]
        if known and missing:
            issues.append({"kind": "unsupported_figure", "claim": text,
                           "detail": f"Figures {', '.join(missing)} are not in the cited findings."})
    for conflict in synthesis.get("conflicts", []):
        if len({s.get("source_id") for s in conflict.get("sides", [])}) < 2:
            issues.append({"kind": "conflict_dropped_side", "claim": str(conflict.get("measure", "")),
                           "detail": "A conflict must show every source's figure side by side."})
    return issues


def compute_coverage(subquestions: list[dict[str, str]], findings: list[dict[str, Any]],
                     synthesis: dict[str, Any] | None, unavailable: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """For each sub-question: well supported, contested, or a gap, with the sources that could not be read."""
    rows = []
    cant = ", ".join(f"{u['source_id']} ({u['failure_type']})" for u in unavailable)
    for sq in subquestions:
        if synthesis is not None:
            claims = [c for c in synthesis.get("claims", []) if c.get("sub_question_id") == sq["id"]]
            statuses = [c.get("status") for c in claims]
            gap = next((g.get("reason", "") for g in synthesis.get("gaps", []) if g.get("sub_question_id") == sq["id"]),
                       "")
        else:
            claims = [f for f in findings if f.get("sub_question") == sq["id"]]
            statuses, gap = ["single_source" if claims else ""], ""
        n_sources = len({s for c in claims for s in (c.get("source_ids") or [c.get("source_id")]) if s})
        if not claims:
            status = "gap"
            note = gap or "No finding answers this sub-question."
            if cant:
                note += f" Sources that could not be read: {cant}."
        elif "contested" in statuses:
            status, note = "contested", "Sources give different figures; both are kept."
        else:
            status = "supported"
            note = f"{n_sources} source{'s' if n_sources != 1 else ''}."
            if gap:
                status, note = "partial", gap
        rows.append({"id": sq["id"], "text": sq["text"], "status": status, "claims": len(claims), "note": note})
    return rows


def run_parallel(fns: list[Callable[[], Any]], workers: int = 4) -> tuple[list[Any], float, float]:
    """Runs the calls at the same time. Returns their results, the wall-clock time and the sum of their own times."""
    durations = [0.0] * len(fns)

    def timed(i: int) -> Any:
        started = time.perf_counter()
        try:
            return fns[i]()
        finally:
            durations[i] = time.perf_counter() - started

    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(fns)))) as pool:
        futures = [pool.submit(contextvars.copy_context().run, timed, i) for i in range(len(fns))]
        results, error = [], None
        for f in futures:
            try:
                results.append(f.result())
            except BaseException as exc:  # every call finishes before the first failure is raised
                results.append(None)
                error = error or exc
    wall = time.perf_counter() - started
    if error:
        raise error
    return results, wall, sum(durations)


# ---------- the subagents ----------

def _tool(name: str, description: str, properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"name": name, "description": description,
            "input_schema": {"type": "object", "properties": properties, "required": required or list(properties)}}


_STR = {"type": "string"}
SEARCH_TOOLS = [
    _tool("search_corpus", "Searches the source corpus. Returns matching sources (id, title, publisher, date, "
                           "abstract). An empty list is a valid result: nothing matched.", {"query": _STR}),
    _tool("fetch_source", "Fetches the full text of one source by id. It can fail: a timeout may work on a second "
                          "try, an access refusal will not.", {"source_id": _STR}),
]
VERIFY_TOOL = _tool("verify_claim", "Checks a claim against one source from the findings you were given: every "
                                    "figure in the claim must appear in that source's text.",
                    {"claim": _STR, "source_id": _STR})
FINDING = {"type": "object", "properties": {"claim": _STR, "evidence": {"type": "string", "description":
           "An exact excerpt from the source's text"}, "source_id": _STR, "sub_question": _STR},
           "required": ["claim", "evidence", "source_id"]}
SUBMIT_FINDINGS = _tool("submit_findings", "Hands in your findings. Call it once, last.", {
    "findings": {"type": "array", "items": FINDING}, "summary": _STR}, ["findings"])
SUBMIT_ANALYSIS = _tool("submit_analysis", "Hands in the figures you extracted. Call it once, last.", {
    "figures": {"type": "array", "items": {"type": "object", "properties": {
        "measure": {"type": "string", "description": "A short lower-case name, the same for the same measure"},
        "value": {"type": "number"}, "unit": _STR, "source_id": _STR,
        "year": {"type": "integer", "description": "The year the figure describes, not the publication year"}},
        "required": ["measure", "value", "unit", "source_id", "year"]}}, "summary": _STR}, ["figures"])
CLAIM = {"type": "object", "properties": {
    "sub_question_id": _STR, "claim": _STR, "source_ids": {"type": "array", "items": _STR},
    "status": {"type": "string", "enum": ["established", "contested", "single_source"]}},
    "required": ["sub_question_id", "claim", "source_ids", "status"]}
SUBMIT_SYNTHESIS = _tool("submit_synthesis", "Hands in the synthesis. Call it once, last.", {
    "claims": {"type": "array", "items": CLAIM},
    "conflicts": {"type": "array", "items": {"type": "object", "properties": {
        "measure": _STR, "sides": {"type": "array", "items": {"type": "object", "properties": {
            "source_id": _STR, "value": _STR}}}, "explanation": _STR}}},
    "gaps": {"type": "array", "items": {"type": "object", "properties": {
        "sub_question_id": _STR, "reason": _STR}}}}, ["claims"])
SUBMIT_REPORT = _tool("submit_report", "Hands in the report. Call it once, last.", {
    "title": _STR, "summary": _STR,
    "sections": {"type": "array", "items": {"type": "object", "properties": {
        "heading": _STR, "kind": {"type": "string", "enum": ["prose", "table"]},
        "status": {"type": "string", "enum": ["established", "contested", "gap"]},
        "text": {"type": "string", "description": "For prose. Cite sources as [S01]."},
        "columns": {"type": "array", "items": _STR},
        "rows": {"type": "array", "items": {"type": "array", "items": _STR}},
        "source_ids": {"type": "array", "items": _STR}}, "required": ["heading", "kind", "source_ids"]}}},
    ["title", "summary", "sections"])

NO_MEMORY = ("You have no memory of earlier work. Everything you know is in the task message below. ")
AGENTS: dict[str, dict[str, Any]] = {
    "search": {
        "description": "Finds and reads sources for one targeted query and records findings with evidence. Use for "
                       "any question that needs facts from the corpus.",
        "prompt": NO_MEMORY + "You are the search agent for a research team. Use search_corpus with short queries, "
                  "then fetch_source for the sources that matter. Record each finding as a claim, an exact excerpt "
                  "of the source text as evidence, and the source id. Never record a claim from a source you did "
                  "not fetch. If a source cannot be fetched, say so in your summary and carry on with the others. "
                  "If a search returns nothing, that is a valid answer: do not invent findings. Then call "
                  "submit_findings.",
        "tools": ["search_corpus", "fetch_source"], "submit": "submit_findings"},
    "analysis": {
        "description": "Reads findings and pulls out the figures with their units and the year each describes. Use "
                       "when the question compares or combines numbers.",
        "prompt": NO_MEMORY + "You are the document analysis agent. You are given findings that carry their "
                  "evidence. Extract every figure that answers the question: its measure (a short lower-case name, "
                  "identical for the same measure in different sources), value, unit, source id, and the year the "
                  "figure describes. Use no outside knowledge. Then call submit_analysis.",
        "tools": [], "submit": "submit_analysis"},
    "synthesis": {
        "description": "Combines findings into claims that each cite their sources, keeps conflicting figures side "
                       "by side, and lists gaps. Use after search, once there is something to combine.",
        "prompt": NO_MEMORY + "You are the synthesis agent. Use only the findings you are given. Write each claim "
                  "against a sub-question, cite the source ids that support it, and mark it established (two or "
                  "more agreeing sources), single_source, or contested. When two sources give different figures "
                  "for the same measure and year, keep both with their sources and mark the claim contested: do not "
                  "choose one. When the figures describe different years, report both with their dates, because a "
                  "newer figure replacing an older one is a change, not a contradiction. List a gap for any "
                  "sub-question the findings do not answer, with the reason, including sources that could not be "
                  "read. Use verify_claim to check a figure against its source. Then call submit_synthesis.",
        "tools": ["verify_claim"], "submit": "submit_synthesis"},
    "report": {
        "description": "Writes the final cited report from a synthesis. Use last.",
        "prompt": NO_MEMORY + "You are the report agent. Write a short report from the synthesis you are given. "
                  "Put numeric comparisons in a table section and explanations in prose sections. Cite sources as "
                  "[S01]. Separate well-established findings from contested ones, show conflicting figures side by "
                  "side with their sources and dates, and say plainly which sub-questions have gaps and why. Use "
                  "only what the synthesis says. Then call submit_report.",
        "tools": [], "submit": "submit_report"},
}
SUBMIT_TOOLS = {t["name"]: t for t in (SUBMIT_FINDINGS, SUBMIT_ANALYSIS, SUBMIT_SYNTHESIS, SUBMIT_REPORT)}
TOOLS_BY_NAME = {t["name"]: t for t in SEARCH_TOOLS + [VERIFY_TOOL]}


def agent_definitions() -> list[dict[str, Any]]:
    """The subagents in the shape of the Agent SDK's AgentDefinition: description, prompt, tools."""
    return [{"name": name, "description": a["description"], "prompt": a["prompt"], "tools": list(a["tools"]),
             "submit_tool": a["submit"]} for name, a in AGENTS.items()]


SUBQUESTIONS_TOOL = _tool("set_subquestions", "Writes or revises the list of sub-questions. Call it first. Call it "
                          "again, with the full list, when a finding shows a sub-question you had not seen.", {
                              "subquestions": {"type": "array", "items": {"type": "object", "properties": {
                                  "id": _STR, "text": _STR}, "required": ["id", "text"]}}})
DELEGATE_TOOL = _tool("delegate", "Gives a task to one subagent. Several delegate calls in one turn run at the same "
                                  "time, so use that for independent work. A subagent knows nothing: list in "
                                  "include_results the step ids of earlier results it needs, and they are written "
                                  "into its prompt in full.", {
                          "agent": {"type": "string", "enum": list(AGENTS)}, "task": _STR,
                          "include_results": {"type": "array", "items": _STR}}, ["agent", "task"])
FINISH_TOOL = _tool("finish", "Ends the run once the report is ready, or when a short answer needs no report.",
                    {"answer": _STR})
COORDINATOR_TOOLS = [SUBQUESTIONS_TOOL, DELEGATE_TOOL, FINISH_TOOL]

COORDINATOR_SYSTEM = f"""You are the coordinator of a research team answering questions about heat pumps in UK homes
from a fixed corpus of sources. You never search or read sources yourself: you delegate to subagents. They are: {', '.join(AGENTS)}.
1. Call set_subquestions to split the question into sub-questions (one for a narrow question, several for a broad one).
2. Decide from the question which subagents are needed. A narrow factual question needs a search and a report, not
   the full pipeline. Combining or comparing numbers needs analysis. Several sub-questions need synthesis.
3. Delegate. Independent searches go in one turn so they run in parallel. Subagents start with an empty context: put
   the step ids of the earlier results they need in include_results, and say exactly what to do in task.
4. After synthesis you get a coverage check. For a sub-question with a gap, delegate a new, targeted search (at most
   {MAX_REFINEMENTS} rounds of this), then synthesise again. If a source could not be read, try other sources or say
   so; do not give up the run. If a finding shows a sub-question you had not listed, add it with set_subquestions.
5. Finish with the report agent, passing the synthesis (or the findings, for a narrow question), then call finish.
Treat a failed source and an empty search differently: a failure means the answer may exist but could not be read; an
empty result means the corpus has nothing."""


def _key(agent: str, task: str, include: list[str]) -> str:
    return f"{agent}|{_norm(task)}|{','.join(sorted(include))}"


def render_result(step: dict[str, Any], result: dict[str, Any]) -> str:
    """One earlier result, written out in full for a subagent's prompt."""
    head = f"### Result {step['id']} ({step['agent']}): {step['task']}"
    lines = [head]
    for f in result.get("findings", []):
        lines.append(f"- [{f['source_id']}] {f['title']}, {f['publisher']}, {f['date']}\n  claim: {f['claim']}\n"
                     f"  evidence: \"{f['evidence']}\"")
    for fig in result.get("figures", []):
        lines.append(f"- figure [{fig['source_id']}] {fig['measure']} = {fig['value']} {fig.get('unit', '')} "
                     f"(year {fig['year']}, published {fig.get('date', '')})")
    for c in result.get("comparisons", []):
        sides = "; ".join(f"{s['source_id']}: {s['value']} ({s['year']})" for s in c["sides"])
        lines.append(f"- comparison {c['measure']}: {c['relation']} ({sides})")
    for c in result.get("claims", []):
        lines.append(f"- claim for {c.get('sub_question_id')} [{', '.join(c.get('source_ids', []))}] "
                     f"({c.get('status')}): {c.get('claim')}")
    for c in result.get("conflicts", []):
        sides = "; ".join(f"{s.get('source_id')}: {s.get('value')}" for s in c.get("sides", []))
        lines.append(f"- conflict {c.get('measure')}: {sides}. {c.get('explanation', '')}")
    for g in result.get("gaps", []):
        lines.append(f"- gap {g.get('sub_question_id')}: {g.get('reason')}")
    for e in result.get("errors", []):
        lines.append(f"- could not read: {json.dumps(e, ensure_ascii=False)}")
    for q in result.get("empty_queries", []):
        lines.append(f"- valid empty result (nothing in the corpus) for query: {q}")
    if result.get("summary"):
        lines.append(f"- agent's summary: {result['summary']}")
    return "\n".join(lines)


def build_prompt(question: str, subquestions: list[dict[str, str]], task: str,
                 prior: list[tuple[dict[str, Any], dict[str, Any]]]) -> str:
    """The exact message a subagent receives: the task, the question, and every prior result passed to it in full."""
    sq = "\n".join(f"- {s['id']}: {s['text']}" for s in subquestions) or "(none yet)"
    parts = [f"Task: {task}", f"Original question: {question}", f"Sub-questions:\n{sq}"]
    if prior:
        parts.append("Prior results passed to you by the coordinator:\n\n" + "\n\n".join(
            render_result(step, result) for step, result in prior))
    else:
        parts.append("Prior results: none. Start from the task above.")
    return "\n\n".join(parts)


class StopRun(Exception):
    """The run reached its budget, the page went away, or a crash was simulated."""


class CrashSimulated(StopRun):
    """The run stopped on purpose after some subagents, to show resuming from the manifest."""


class Budget:
    def __init__(self, cap: float) -> None:
        self.cap, self.spent = cap, 0.0
        self._lock = threading.Lock()

    def add(self, cost: float) -> None:
        with self._lock:
            self.spent += cost


class Manifest:
    """What the run has done, on disk: per subagent step its status and findings file. A resume reads it back."""

    def __init__(self, folder: Path, data: dict[str, Any]) -> None:
        self.folder, self.data = folder, data
        self._lock = threading.Lock()

    @classmethod
    def create(cls, root: Path, run_id: str, question: str, model: str) -> "Manifest":
        folder = root / run_id
        folder.mkdir(parents=True, exist_ok=True)
        m = cls(folder, {"run_id": run_id, "question": question, "model": model, "status": "running",
                         "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                         "subquestions": [], "steps": [], "final": None})
        m.save()
        return m

    @classmethod
    def load(cls, root: Path, run_id: str) -> "Manifest":
        if not RUN_ID.match(run_id):
            raise ApiError(400, "invalid_request", "That is not a run id.")
        path = root / run_id / "manifest.json"
        if not path.is_file():
            raise ApiError(404, "not_found", "No manifest for that run.")
        return cls(path.parent, json.loads(path.read_text(encoding="utf-8")))

    def save(self) -> None:
        with self._lock:
            tmp = self.folder / "manifest.json.tmp"
            tmp.write_text(json.dumps(self.data, indent=2, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.folder / "manifest.json")

    def step(self, step_id: str) -> dict[str, Any] | None:
        return next((s for s in self.data["steps"] if s["id"] == step_id), None)

    def find_done(self, key: str) -> dict[str, Any] | None:
        return next((s for s in self.data["steps"] if s["key"] == key and s["status"] == "done"), None)

    def add_step(self, agent: str, task: str, include: list[str], key: str) -> dict[str, Any]:
        with self._lock:
            used = [int(s["id"][1:]) for s in self.data["steps"]]
            step = {"id": f"a{max(used, default=0) + 1}", "agent": agent, "task": task, "include": include,
                    "key": key, "status": "running", "findings_file": None}
            self.data["steps"].append(step)
        self.save()
        return step

    def finish_step(self, step: dict[str, Any], result: dict[str, Any], seconds: float) -> None:
        file = f"{step['id']}_{step['agent']}.json"
        (self.folder / file).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        with self._lock:
            step.update(status="done" if result.get("status") != "failed" else "failed", findings_file=file,
                        seconds=round(seconds, 2), summary=result.get("summary", ""))
        self.save()

    def result_of(self, step: dict[str, Any]) -> dict[str, Any]:
        return json.loads((self.folder / step["findings_file"]).read_text(encoding="utf-8"))

    def view(self) -> dict[str, Any]:
        return {k: self.data[k] for k in ("run_id", "question", "status", "steps", "subquestions", "model")} | {
            "folder": str(self.folder), "interrupted": self.data.get("interrupted", [])}


class TeamRun:
    """One run of the team: the corpus, the manifest, the sub-questions, and the results so far."""

    def __init__(self, svc: "ResearchTeamService", run: Run, model: str, budget: Budget, manifest: Manifest,
                 stop_after: int | None) -> None:
        self.svc, self.run, self.model, self.budget, self.manifest = svc, run, model, budget, manifest
        self.corpus = Corpus()
        self.results: dict[str, dict[str, Any]] = {}
        self.stop_after, self.completed = stop_after, 0
        self.refinements, self.synthesised = 0, False
        self.finished = False
        self.cost = 0.0
        self.calls = 0
        self._lock = threading.Lock()
        self.question = manifest.data["question"]
        self.subquestions: list[dict[str, str]] = list(manifest.data["subquestions"])
        self.call_seq = 0
        self.final: dict[str, Any] | None = None

    def emit(self, type_: str, **fields: Any) -> None:
        self.run.publish({"type": type_, **fields})

    def next_call_id(self) -> str:
        with self._lock:
            self.call_seq += 1
            return f"c{self.call_seq}"

    # ----- one model call, charged and published -----

    def call(self, who: str, call_id: str, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]],
             turn: int) -> Any:
        if self.run.cancelled.is_set():
            raise StopRun("The page went away.")
        if self.budget.spent >= self.budget.cap:
            raise StopRun(f"Stopped: the run reached its budget (${self.budget.cap:.2f}).")
        started = time.perf_counter()
        try:
            response = self.svc.claude.create(model=self.model, max_tokens=MAX_TOKENS, system=system,
                                              messages=messages, tools=tools)
        except Exception as exc:
            raise to_api_error(exc) from exc
        seconds = time.perf_counter() - started
        cost = self.svc.spend.charge(response, self.model) or 0.0
        self.budget.add(cost)
        with self._lock:
            self.cost += cost
            self.calls += 1
        usage = response.usage
        self.emit("turn", agent=who, call_id=call_id, turn=turn, seconds=round(seconds, 2), cost_usd=round(cost, 6),
                  input_tokens=getattr(usage, "input_tokens", 0) or 0,
                  output_tokens=getattr(usage, "output_tokens", 0) or 0, text=text_of(response).strip(),
                  tools=[b.name for b in response.content if b.type == "tool_use"])
        return response

    # ----- subagents -----

    def run_subagent(self, step: dict[str, Any], prompt: str) -> dict[str, Any]:
        agent = step["agent"]
        spec = AGENTS[agent]
        call_id = step["call_id"]
        tools = [TOOLS_BY_NAME[n] for n in spec["tools"]] + [SUBMIT_TOOLS[spec["submit"]]]
        state: dict[str, Any] = {"fetched": {}, "seen": {}, "errors": [], "empty": [], "retries": [], "submitted": None,
                                 "known": set(step.get("known_sources", []))}
        messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
        cost_before = self.cost
        for turn in range(1, MAX_SUBAGENT_TURNS + 1):
            response = self.call(agent, call_id, spec["prompt"], messages, tools, turn)
            content, results = [], []
            for block in response.content:
                if block.type == "text" and block.text.strip():
                    content.append({"type": "text", "text": block.text})
                elif block.type == "tool_use":
                    content.append({"type": "tool_use", "id": block.id, "name": block.name, "input": block.input})
                    out = self.exec_tool(agent, call_id, spec, state, block.name, dict(block.input))
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": json.dumps(out, ensure_ascii=False),
                                    **({"is_error": True} if "error" in out else {})})
            if state["submitted"] is not None or not results:
                break
            messages = messages + [{"role": "assistant", "content": content}, {"role": "user", "content": results}]
        return self.finish_subagent(agent, state, cost_before)

    def exec_tool(self, agent: str, call_id: str, spec: dict[str, Any], state: dict[str, Any], name: str,
                  args: dict[str, Any]) -> dict[str, Any]:
        """Runs one tool call for a subagent, only if the tool is in its scope. Transient failures retry here."""
        if name not in spec["tools"] and name != spec["submit"]:
            out = {"error": {"failure_type": "tool_not_available", "transient": False,
                             "message": f"{name} is not one of this agent's tools ({', '.join(spec['tools']) or 'none'})."}}
            self.emit("tool", agent=agent, call_id=call_id, tool=name, input=args, ok=False, result=out, attempt=1)
            return out
        started = time.perf_counter()
        attempt, out = 1, {}
        while True:
            out = self._run_tool(state, name, args)
            ok = "error" not in out
            self.emit("tool", agent=agent, call_id=call_id, tool=name, input=args, ok=ok, attempt=attempt,
                      result=out if name != "fetch_source" or not ok else {"source_id": out["source"]["id"],
                                                                         "title": out["source"]["title"]},
                      seconds=round(time.perf_counter() - started, 3))
            err = out.get("error") if isinstance(out.get("error"), dict) else None
            if err and err.get("transient") and attempt <= MAX_FETCH_RETRIES:
                state["retries"].append({"tool": name, "source_id": err.get("source_id", ""),
                                         "failure_type": err["failure_type"], "attempt": attempt})
                self.emit("retry", agent=agent, call_id=call_id, tool=name, failure_type=err["failure_type"],
                          attempt=attempt)
                attempt += 1
                continue
            break
        err = out.get("error") if isinstance(out.get("error"), dict) else None
        if err and name == "fetch_source":
            state["errors"].append(err)
        return out

    def _run_tool(self, state: dict[str, Any], name: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            if name == "search_corpus":
                out = self.corpus.search(str(args.get("query", "")))
                state["seen"][out["query"]] = [r["source_id"] for r in out["results"]]
                if not out["results"]:
                    state["empty"].append(out["query"])
                return out
            if name == "fetch_source":
                out = self.corpus.fetch(str(args.get("source_id", "")))
                if "source" in out:
                    state["fetched"][out["source"]["id"]] = out["source"]
                return out
            if name == "verify_claim":
                sid = str(args.get("source_id", "")).strip().upper()
                if sid not in state["known"]:
                    return {"error": {"failure_type": "not_in_findings", "transient": False,
                                      "message": f"{sid} is not among the findings you were given."}}
                source = SOURCES_BY_ID[sid]
                have = set(_numbers(source["text"]))
                missing = [n for n in _numbers(str(args.get("claim", ""))) if n not in have]
                return {"source_id": sid, "supported": not missing, "figures_not_in_source": missing}
            if name in SUBMIT_TOOLS:
                state["submitted"] = args
                return {"accepted": True}
        except (KeyError, TypeError, ValueError) as exc:
            return {"error": {"failure_type": "bad_input", "transient": False, "message": str(exc) or "bad input"}}
        return {"error": {"failure_type": "unknown_tool", "transient": False, "message": f"No tool {name}."}}

    def finish_subagent(self, agent: str, state: dict[str, Any], cost_before: float) -> dict[str, Any]:
        sub = state["submitted"]
        result: dict[str, Any] = {"agent": agent, "summary": "", "errors": [], "empty_queries": state["empty"],
                                  "retries": state["retries"]}
        if sub is None:
            result["status"] = "failed"
            result["errors"].append(error_context("no_output", agent, [], [], "The agent ended without handing in "
                                                  "its result."))
            return result
        result["summary"] = str(sub.get("summary", ""))
        if agent == "search":
            findings, rejected = [], []
            for f in sub.get("findings", []):
                sid = str(f.get("source_id", "")).strip().upper()
                f = {**f, "source_id": sid}
                if sid not in state["fetched"]:
                    rejected.append({"source_id": sid, "reason": "the source was not fetched by this agent"})
                elif not evidence_in_source(str(f.get("evidence", "")), sid, state["fetched"]):
                    rejected.append({"source_id": sid, "reason": "the evidence is not in the source's text"})
                else:
                    findings.append(attach_source(f, state["fetched"]))
            result["findings"], result["rejected"] = findings, rejected
            got = [{"source_id": s["id"], "title": s["title"]} for s in state["fetched"].values()]
            seen = [i for ids in state["seen"].values() for i in ids]
            for err in state["errors"]:
                sid = err.get("source_id", "")
                alts = [{"source_id": i, "title": SOURCES_BY_ID[i]["title"]} for i in dict.fromkeys(seen)
                        if i != sid and i not in state["fetched"] and i in SOURCES_BY_ID and i != BLOCKED_ID][:3]
                result["errors"].append(error_context(err["failure_type"], f"fetch_source({sid})", got, alts,
                                                      err.get("message", "")) | {"source_id": sid})
            # a transient failure that a retry fixed is a retry, not an error
            result["errors"] = [e for e in result["errors"] if not (
                e["failure_type"] == "timeout" and e["source_id"] in state["fetched"])]
            if result["errors"]:
                result["status"] = "partial" if findings else "failed"
            else:
                result["status"] = "ok"
        elif agent == "analysis":
            figures = []
            for f in sub.get("figures", []):
                s = SOURCES_BY_ID.get(str(f.get("source_id", "")).strip().upper())
                try:
                    figures.append({**f, "source_id": s["id"], "date": s["date"], "year": int(f["year"]),
                                    "value": float(f["value"])} if s else None)
                except (KeyError, TypeError, ValueError):
                    figures.append(None)
            result["figures"] = [f for f in figures if f]
            result["comparisons"] = compare_figures(result["figures"])
            result["status"] = "ok"
        elif agent == "synthesis":
            result["claims"] = list(sub.get("claims", []))
            result["conflicts"] = list(sub.get("conflicts", []))
            result["gaps"] = list(sub.get("gaps", []))
            findings = [f for r in self.results.values() for f in r.get("findings", [])]
            result["issues"] = check_provenance(findings, result)
            result["status"] = "ok"
        else:
            known = {f["source_id"] for r in self.results.values() for f in r.get("findings", [])}
            sections = list(sub.get("sections", []))
            cited = list(dict.fromkeys(i for s in sections for i in s.get("source_ids", [])))
            result.update(title=str(sub.get("title", "")), report_summary=str(sub.get("summary", "")),
                          sections=sections,
                          cited_sources=[{k: SOURCES_BY_ID[i][k] for k in ("id", "title", "publisher", "date")}
                                         for i in cited if i in SOURCES_BY_ID],
                          unknown_citations=[i for i in cited if i not in SOURCES_BY_ID or i not in known],
                          status="ok")
        result["cost_usd"] = round(self.cost - cost_before, 6)
        return result

    # ----- delegation -----

    def known_sources(self, prior: list[tuple[dict[str, Any], dict[str, Any]]]) -> list[str]:
        return sorted({f["source_id"] for _, r in prior for f in r.get("findings", [])})

    def delegate(self, args: dict[str, Any]) -> tuple[str, bool]:
        """One delegate call from the coordinator. Returns the text for its tool_result and whether it is an error."""
        agent, task = str(args.get("agent", "")), str(args.get("task", "")).strip()
        include = [str(i) for i in args.get("include_results") or []]
        if agent not in AGENTS or not task:
            return json.dumps({"error": f"delegate needs an agent from {list(AGENTS)} and a task."}), True
        missing = [i for i in include if i not in self.results]
        if missing:
            return json.dumps({"error": f"No finished result with id {missing}. Finished: {list(self.results)}."}), True
        key = _key(agent, task, include)
        done = self.manifest.find_done(key)
        if done is not None:  # finished earlier in this run or before a crash: reuse it, no model call
            result = self.manifest.result_of(done)
            self.results[done["id"]] = result
            self.emit("agent_done", agent=agent, step=done["id"], call_id="", status=result.get("status"),
                      cached=True, task=task, seconds=0, cost_usd=0, result=_public(result))
            return self.coordinator_view(done, result), False
        with self._lock:
            if agent == "search" and self.synthesised:
                if self.refinements >= MAX_REFINEMENTS:
                    return json.dumps({"error": f"The refinement cap ({MAX_REFINEMENTS} rounds) is reached. Go on "
                                                "to the report with what you have, and say what is missing."}), True
        prior = [({"id": i, "agent": self.results[i]["agent"], "task": self.step_task(i)}, self.results[i])
                 for i in include]
        if self.stop_after is not None and self.completed >= self.stop_after:
            step = self.manifest.add_step(agent, task, include, key)  # left "running": the crash caught it mid-work
            raise CrashSimulated(f"Simulated crash while {step['id']} ({agent}) was running.")
        step = self.manifest.add_step(agent, task, include, key)
        step["call_id"] = self.next_call_id()
        step["known_sources"] = self.known_sources(prior)
        if agent == "search" and self.synthesised:
            with self._lock:
                self.refinements += 1
        prompt = build_prompt(self.question, self.subquestions, task, prior)
        self.emit("agent_start", agent=agent, step=step["id"], call_id=step["call_id"], task=task, system=
                  AGENTS[agent]["prompt"], prompt=prompt, tools=AGENTS[agent]["tools"] + [AGENTS[agent]["submit"]],
                  included=include)
        started = time.perf_counter()
        result = self.run_subagent(step, prompt)
        seconds = time.perf_counter() - started
        self.results[step["id"]] = result
        self.manifest.finish_step(step, result, seconds)
        with self._lock:
            self.completed += 1
            if agent == "synthesis":
                self.synthesised = True
        self.emit("agent_done", agent=agent, step=step["id"], call_id=step["call_id"], status=result.get("status"),
                  cached=False, task=task, seconds=round(seconds, 2), cost_usd=result.get("cost_usd", 0),
                  result=_public(result))
        self.emit("manifest", **self.manifest.view())
        if agent == "report":
            self.emit("report", **self.build_report(result))
        return self.coordinator_view(step, result), False

    def step_task(self, step_id: str) -> str:
        step = self.manifest.step(step_id)
        return step["task"] if step else ""

    def all_findings(self) -> list[dict[str, Any]]:
        return [f for r in self.results.values() for f in r.get("findings", [])]

    def unavailable(self) -> list[dict[str, Any]]:
        seen: dict[str, dict[str, Any]] = {}
        resolved = {f["source_id"] for f in self.all_findings()}
        for r in self.results.values():
            for e in r.get("errors", []):
                if e.get("source_id") and e["source_id"] not in resolved:
                    seen[e["source_id"]] = e
        return list(seen.values())

    def synthesis(self) -> dict[str, Any] | None:
        done = [r for r in self.results.values() if r.get("agent") == "synthesis"]
        return done[-1] if done else None

    def coverage(self) -> list[dict[str, Any]]:
        return compute_coverage(self.subquestions, self.all_findings(), self.synthesis(), self.unavailable())

    def coordinator_view(self, step: dict[str, Any], result: dict[str, Any]) -> str:
        """What the coordinator sees of a finished subagent: short, with errors and coverage kept structured."""
        view: dict[str, Any] = {"step": step["id"], "agent": step["agent"], "status": result.get("status"),
                                "summary": result.get("summary", "")}
        if step["agent"] == "search":
            view["findings"] = [{"claim": f["claim"], "source_id": f["source_id"], "date": f["date"]}
                                for f in result.get("findings", [])]
            view["errors"], view["empty_queries"] = result.get("errors", []), result.get("empty_queries", [])
            if result.get("empty_queries"):
                view["note"] = "An empty query is a valid result: the corpus has nothing on it."
        elif step["agent"] == "analysis":
            view["comparisons"] = result.get("comparisons", [])
            view["figures"] = len(result.get("figures", []))
        elif step["agent"] == "synthesis":
            cov = self.coverage()
            view.update(claims=len(result.get("claims", [])), issues=result.get("issues", []), coverage=cov,
                        refinements_left=max(0, MAX_REFINEMENTS - self.refinements))
            self.emit("coverage", step=step["id"], coverage=cov, refinements_used=self.refinements,
                      refinements_cap=MAX_REFINEMENTS, unavailable=self.unavailable())
        elif step["agent"] == "report":
            view["cited_sources"] = [s["id"] for s in result.get("cited_sources", [])]
            view["unknown_citations"] = result.get("unknown_citations", [])
        return json.dumps(view, ensure_ascii=False)

    def build_report(self, result: dict[str, Any]) -> dict[str, Any]:
        return {"title": result.get("title", ""), "summary": result.get("report_summary", ""),
                "sections": result.get("sections", []), "cited_sources": result.get("cited_sources", []),
                "unknown_citations": result.get("unknown_citations", []), "coverage": self.coverage(),
                "unavailable": self.unavailable(), "subquestions": self.subquestions,
                "issues": (self.synthesis() or {}).get("issues", [])}

    def set_subquestions(self, args: dict[str, Any]) -> str:
        items = [{"id": str(s.get("id", "")).strip() or f"q{i}", "text": str(s.get("text", "")).strip()}
                 for i, s in enumerate(args.get("subquestions") or [], 1) if str(s.get("text", "")).strip()]
        if not items:
            return json.dumps({"error": "Give at least one sub-question."})
        added = [i["id"] for i in items if i["id"] not in {s["id"] for s in self.subquestions}]
        revision = (self.manifest.data.get("sq_revision", -1)) + 1
        self.subquestions = items
        self.manifest.data["subquestions"], self.manifest.data["sq_revision"] = items, revision
        self.manifest.save()
        self.emit("subquestions", items=items, revision=revision, added=added if revision else [])
        return json.dumps({"ok": True, "subquestions": items})

    # ----- the coordinator -----

    def coordinate(self, resumed: bool) -> None:
        done = [s for s in self.manifest.data["steps"] if s["status"] == "done"]
        first = f"Question: {self.question}"
        if resumed:
            for s in done:
                result = self.manifest.result_of(s)
                self.results[s["id"]] = result
                if s["agent"] == "synthesis":
                    self.synthesised = True
            # Code, not the model, finishes the interrupted steps: same agent, same task, same inputs, so nothing that
            # already finished is redone, whatever the coordinator would have worded differently.
            for s in self.manifest.data.get("interrupted", []):
                if all(i in self.results for i in s.get("include") or []):
                    self.delegate({"agent": s["agent"], "task": s["task"], "include_results": s.get("include") or []})
            lines = [f"- {s['id']} ({s['agent']}, {self.results[s['id']].get('status')}): {s['task']}"
                     for s in self.manifest.data["steps"] if s["status"] == "done" and s["id"] in self.results]
            first += ("\n\nThis run was interrupted and has been resumed. These steps are finished and their results "
                      "are available by id:\n" + ("\n".join(lines) or "(none)")
                      + "\nSub-questions so far: " + json.dumps(self.subquestions) + "\nDo not search again for what "
                      "these cover. Build on them: pass their ids in include_results and continue with the next step "
                      "that has not been done (synthesis, a coverage check or the report).")
            self.emit("subquestions", items=self.subquestions, revision=self.manifest.data.get("sq_revision", 0),
                      added=[])
        messages: list[dict[str, Any]] = [{"role": "user", "content": first}]
        for turn in range(1, MAX_COORDINATOR_TURNS + 1):
            call_id = self.next_call_id()
            response = self.call("coordinator", call_id, COORDINATOR_SYSTEM, messages, COORDINATOR_TOOLS, turn)
            content, uses = [], []
            for block in response.content:
                if block.type == "text" and block.text.strip():
                    content.append({"type": "text", "text": block.text})
                elif block.type == "tool_use":
                    content.append({"type": "tool_use", "id": block.id, "name": block.name, "input": block.input})
                    uses.append(block)
            if not uses:
                self.final = {"answer": text_of(response).strip()}
                return
            outputs: dict[str, tuple[str, bool]] = {}
            delegates = [b for b in uses if b.name == "delegate"]
            for b in uses:
                if b.name == "set_subquestions":
                    outputs[b.id] = (self.set_subquestions(dict(b.input)), False)
                elif b.name == "finish":
                    self.final = {"answer": str(b.input.get("answer", ""))}
                    outputs[b.id] = ("Run ended.", False)
                elif b.name != "delegate":
                    outputs[b.id] = (json.dumps({"error": f"No tool {b.name}."}), True)
            if delegates:
                self.emit("delegating", agents=[d.input.get("agent") for d in delegates], parallel=
                          self.svc.parallel and len(delegates) > 1)
                if self.svc.parallel and len(delegates) > 1:
                    outs, wall, total = run_parallel([(lambda d=d: self.delegate(dict(d.input))) for d in delegates])
                    self.emit("parallel", agents=[d.input.get("agent") for d in delegates], wall_s=round(wall, 2),
                              sum_s=round(total, 2), saved_s=round(total - wall, 2))
                else:
                    outs = [self.delegate(dict(d.input)) for d in delegates]
                for d, o in zip(delegates, outs):
                    outputs[d.id] = o
            results = [{"type": "tool_result", "tool_use_id": b.id, "content": outputs[b.id][0],
                        **({"is_error": True} if outputs[b.id][1] else {})} for b in uses]
            if self.final is not None:
                return
            messages = messages + [{"role": "assistant", "content": content}, {"role": "user", "content": results}]
        self.final = {"answer": "", "stopped": f"Stopped at the coordinator's turn cap ({MAX_COORDINATOR_TURNS})."}


def _public(result: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in result.items()}


class ResearchTeamService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, generated_dir: Path,
                 streamer: RunStreamer | None = None, parallel: bool = True) -> None:
        self.claude, self.spend, self.streamer, self.parallel = claude, spend, streamer, parallel
        self.root = Path(generated_dir) / "research-team"
        self._active: set[str] = set()  # runs being worked on now, so one cannot be resumed twice at once
        self._active_lock = threading.Lock()

    def info(self) -> dict[str, Any]:
        return {"questions": QUESTIONS, "agents": agent_definitions(),
                "coordinator": {"system": COORDINATOR_SYSTEM, "tools": [t["name"] for t in COORDINATOR_TOOLS]},
                "tools": {name: t["description"] for name, t in (TOOLS_BY_NAME | SUBMIT_TOOLS).items()},
                "sources": [{k: s[k] for k in ("id", "title", "publisher", "date", "abstract")} for s in SOURCES],
                "limits": {"coordinator_turns": MAX_COORDINATOR_TURNS, "subagent_turns": MAX_SUBAGENT_TURNS,
                           "refinements": MAX_REFINEMENTS, "fetch_retries": MAX_FETCH_RETRIES},
                "transient_id": TRANSIENT_ID, "blocked_id": BLOCKED_ID}

    def runs(self) -> list[dict[str, Any]]:
        """Runs with a manifest on disk, newest first, with what a resume would redo."""
        out = []
        for path in sorted(self.root.glob("*/manifest.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:20]:
            try:
                m = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            steps = m.get("steps", [])
            out.append({"run_id": m["run_id"], "question": m["question"], "status": m["status"],
                        "done": sum(s["status"] == "done" for s in steps),
                        "unfinished": sum(s["status"] != "done" for s in steps)})
        return out

    def run(self, question: str, model: str | None, budget_usd: float, stop_after: int | None = None,
            resume_id: str | None = None) -> Iterator[str]:
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        model = model or DEFAULT_MODEL
        if resume_id:
            with self._active_lock:  # checked before the manifest on disk is touched
                if resume_id in self._active:
                    raise ApiError(409, "running", "That run is still going. Wait for it to finish or crash first.")
                self._active.add(resume_id)
            try:
                manifest = Manifest.load(self.root, resume_id)
            except Exception:
                with self._active_lock:
                    self._active.discard(resume_id)
                raise
            model = manifest.data.get("model") or model  # a run keeps the model it started with
            steps = manifest.data["steps"]
            manifest.data["interrupted"] = [s for s in steps if s["status"] != "done"]  # to be done again
            manifest.data["steps"] = [s for s in steps if s["status"] == "done"]
            manifest.data["status"] = "running"
            manifest.save()
        else:
            manifest = Manifest.create(self.root, uuid.uuid4().hex[:12], question.strip(), model)
            with self._active_lock:
                self._active.add(manifest.data["run_id"])
        run_id = manifest.data["run_id"]
        run, budget = Run(), Budget(budget_usd)
        team = TeamRun(self, run, model, budget, manifest, stop_after)
        started = time.perf_counter()

        def work() -> None:
            run.publish({"type": "started", "run_id": manifest.data["run_id"], "question": team.question,
                         "model": model, "budget_usd": budget_usd, "resumed": bool(resume_id)})
            status = "done"
            try:
                team.coordinate(bool(resume_id))
            except CrashSimulated as exc:
                status = "crashed"
                run.publish({"type": "crashed", "message": str(exc), "run_id": manifest.data["run_id"]})
            except StopRun as exc:
                status = "stopped"
                run.publish({"type": "note", "message": str(exc)})
            except ApiError as exc:
                status = "error"
                run.publish({"type": "error", "message": exc.message})
            except Exception as exc:
                status = "error"
                run.publish({"type": "error", "message": describe(exc)})
            manifest.data["status"] = status
            manifest.data["final"] = team.final
            manifest.save()
            run.publish({"type": "manifest", **manifest.view()})
            with self._active_lock:
                self._active.discard(run_id)
            run.publish({"type": "done", "status": status, "final": team.final, "spent_usd": round(budget.spent, 6),
                         "model_calls": team.calls, "seconds": round(time.perf_counter() - started, 2),
                         "run_id": manifest.data["run_id"], "model": model})

        return self.streamer.lines(run, work)
