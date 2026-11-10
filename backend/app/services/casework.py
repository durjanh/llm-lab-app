"""Case handling on Azure: a council's housing-repair complaints, worked by agents, approved by a person.

The flow, for one complaint:
1. Intake agent: what the resident is complaining about and wants (structured output).
2. Evidence agent: gathers facts from three legacy systems of record through read-only tools.
3. Policy retrieval: plans search queries and runs hybrid search (keywords + vectors, semantic
   reranking) over the council's policies in Azure AI Search.
4. Drafting agent: the decision, the compensation and the letter, with every claim citing a fact or policy.
5. Checks. A separate model call checks each claim against what it cites (groundedness). Code
   recomputes the decision and compensation from the records and the policy rules (rule check):
   the model proposes, code verifies.
6. A named caseworker approves (optionally editing the letter) or rejects. Only then is it "sent".

Every step goes into an append-only audit log whose entries are hash-chained, so any edit to an
earlier entry shows. The same pipeline runs over a gold set to gate a release (evaluate()).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import threading
import uuid
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ..core.errors import ApiError
from ..gateways.azure_search import AzureSearch
from .casework_data import CASES, CONTACTS, EXPECTED, POLICIES, REPAIRS, TENANCY, TODAY
from .spend import SpendTracker

INDEX = "casework-policies"
SEMANTIC = "policy-semantic"
DIMENSIONS = 1536  # text-embedding-3-small
GATE = {"decision_accuracy": 0.8, "compensation_accuracy": 0.8, "groundedness": 0.9}


def version(prompt: str) -> str:
    """A prompt's version: a short hash of its text, recorded with every call so an output can be traced to it."""
    return hashlib.sha256(prompt.encode()).hexdigest()[:8]


INTAKE = """You are the intake agent for a council's housing complaints team. Read the resident's complaint and record what it is about, the separate issues raised, what the resident wants, and any vulnerability they mention. Use only what the complaint says."""

EVIDENCE = """You are the evidence agent. Gather the facts needed to decide this complaint from the council's systems of record, using the tools: the tenancy record (household and recorded vulnerabilities), the repairs record for the property, and the contact history for the case. Call each tool you need, then return the facts. Each fact is one short, specific statement copied from a record (dates exactly as recorded), with the record it came from. Do not decide the complaint."""

PLANNER = """You plan searches over the council's policy documents. Given a complaint summary and the facts, write four to six short search queries, one per rule needed to decide it: how to decide the outcome; the repair timescale for each repair type involved; and one query for each kind of payment that might apply (delay payments, a service failure payment for something the council failed to do, a vulnerability payment). Keep each query to a few words about one rule."""

DRAFTER = f"""You are the drafting agent for Stage 1 complaint responses. Today's date is {TODAY}. Decide the complaint strictly by the policy extracts provided, using the facts provided, and draft the response letter.
- decision: upheld, partly_upheld or not_upheld, by the complaints policy.
- compensation: follow the compensation policy exactly. Work out the target date, the days late (calendar days after the target until completion, or until today if still open), the rate, and any service failure and vulnerability payments; show the working. Zero for a complaint that is not upheld.
- letter: a plain-English Stage 1 response to the tenant by name, stating the outcome, the reasons with dates, any compensation and goodwill offer, and how to escalate to Stage 2 and the Housing Ombudsman. Follow the data protection policy.
- claims: every statement of fact or policy the letter relies on (dates, durations, amounts, rules, what happened), each citing the ids of the facts (F1, F2…) and policy extracts (POL-…) that support it. Cite only ids you were given, and only state what they say. Apologies, courtesy and escalation wording are not claims."""

VERIFIER = """You check a drafted complaint response for groundedness. For each claim, decide whether the cited sources support it. Supported means the sources state it, or it follows from them directly by paraphrase or simple arithmetic (such as counting days between two dates or multiplying by a daily rate); identical wording is not required. Unsupported means it adds a date, amount, fact or rule the sources do not give, or cites nothing relevant. Be brief."""

REVISE = """The checks below found problems with your draft. Revise the decision, compensation, letter and claims to fix them, using only the facts and policy extracts you were given. Where the rule check disagrees with you, re-read the policy extracts and work the figures again; change your answer only where the policy supports the change."""

PROMPTS = {"intake": INTAKE, "evidence": EVIDENCE, "planner": PLANNER, "drafter": DRAFTER, "verifier": VERIFIER, "revise": REVISE}

INTAKE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["summary", "category", "issues", "resident_wants", "vulnerability_mentioned"],
    "properties": {
        "summary": {"type": "string"}, "category": {"type": "string", "enum": ["repairs", "communication", "staff conduct", "other"]},
        "issues": {"type": "array", "items": {"type": "string"}}, "resident_wants": {"type": "array", "items": {"type": "string"}},
        "vulnerability_mentioned": {"type": "string"},
    },
}
FACTS_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["facts"],
    "properties": {"facts": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["fact", "source"],
        "properties": {"fact": {"type": "string"}, "source": {"type": "string", "enum": ["tenancy", "repairs", "contacts", "complaint"]}}}}},
}
PLAN_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["queries"],
    "properties": {"queries": {"type": "array", "items": {"type": "string"}}},
}
DRAFT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["decision", "reasons", "compensation", "goodwill", "letter", "claims"],
    "properties": {
        "decision": {"type": "string", "enum": ["upheld", "partly_upheld", "not_upheld"]},
        "reasons": {"type": "string"},
        "compensation": {"type": "object", "additionalProperties": False,
                         "required": ["target_date", "days_late", "daily_rate_gbp", "delay_gbp", "service_failure_gbp",
                                      "vulnerability_gbp", "total_gbp", "working"],
                         "properties": {"target_date": {"type": "string"}, "days_late": {"type": "integer"},
                                        "daily_rate_gbp": {"type": "integer"}, "delay_gbp": {"type": "integer"},
                                        "service_failure_gbp": {"type": "integer"}, "vulnerability_gbp": {"type": "integer"},
                                        "total_gbp": {"type": "integer"}, "working": {"type": "string"}}},
        "goodwill": {"type": "string"},
        "letter": {"type": "string"},
        "claims": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["claim", "sources"],
                                              "properties": {"claim": {"type": "string"}, "sources": {"type": "array", "items": {"type": "string"}}}}},
    },
}
VERIFY_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["results"],
    "properties": {"results": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["claim", "supported", "note"],
        "properties": {"claim": {"type": "string"}, "supported": {"type": "boolean"}, "note": {"type": "string"}}}}},
}

# The legacy systems, offered to the evidence agent as read-only function tools.
TOOLS = [
    {"type": "function", "function": {"name": "get_tenancy", "description": "The tenancy record: tenant, address, property id, household and recorded vulnerabilities.",
                                      "parameters": {"type": "object", "additionalProperties": False, "required": ["tenant_id"],
                                                     "properties": {"tenant_id": {"type": "string", "description": "Such as T-1042"}}}, "strict": True}},
    {"type": "function", "function": {"name": "get_repairs", "description": "Repair jobs for a property: type, priority, reported and completed dates, target days, notes.",
                                      "parameters": {"type": "object", "additionalProperties": False, "required": ["property_id"],
                                                     "properties": {"property_id": {"type": "string", "description": "Such as P-881"}}}, "strict": True}},
    {"type": "function", "function": {"name": "get_contact_history", "description": "The resident's contacts with the council about this case, and whether each was replied to.",
                                      "parameters": {"type": "object", "additionalProperties": False, "required": ["case_id"],
                                                     "properties": {"case_id": {"type": "string", "description": "Such as C-301"}}}, "strict": True}},
]


def call_tool(name: str, args: dict) -> Any:
    if name == "get_tenancy":
        return TENANCY.get(args.get("tenant_id", ""), {"error": f"No tenancy {args.get('tenant_id')}"})
    if name == "get_repairs":
        return REPAIRS.get(args.get("property_id", ""), {"error": f"No repairs for property {args.get('property_id')}"})
    if name == "get_contact_history":
        return CONTACTS.get(args.get("case_id", ""), {"error": f"No case {args.get('case_id')}"})
    return {"error": f"Unknown tool {name}"}


def policy_chunks() -> list[dict]:
    """Each policy split at its second-level headings: one searchable chunk per rule, with its section name."""
    chunks = []
    for n, (title, text) in enumerate(POLICIES, 1):
        parts = re.split(r"\n(?=## )", text.strip())
        intro = parts[0].split("\n", 1)[1].strip() if "\n" in parts[0] else ""
        sections = ([(title, intro)] if intro else []) + [
            (p.split("\n", 1)[0].removeprefix("## ").strip(), p.split("\n", 1)[1].strip()) for p in parts[1:]]
        for m, (section, body) in enumerate(sections, 1):
            chunks.append({"id": f"POL-{n}{m}", "title": title, "section": section, "content": body})
    return chunks


def days(a: str, b: str) -> int:
    return (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days


def rule_check(case: dict) -> dict:
    """The decision and compensation, worked out by code from the records and the policy rules."""
    tenancy = TENANCY[case["tenant_id"]]
    repair = REPAIRS[tenancy["property_id"]][-1]
    reported = dt.date.fromisoformat(repair["reported"])
    target_days = repair["target_days"]
    if repair["priority"] == "emergency" and repair.get("made_safe") and days(repair["reported"], repair["made_safe"]) <= 1:
        target_days = 7  # made safe within 24 hours: the permanent repair then has 7 days
    target = reported + dt.timedelta(days=target_days)
    end = dt.date.fromisoformat(repair["completed"] or TODAY)
    late = max(0, (end - target).days)
    rate = 10 if repair["priority"] == "emergency" else 5
    service_failure = 50 if (any(c.get("replied") is False for c in CONTACTS[case["case_id"]])
                             or repair.get("heaters_supplied") is False) else 0
    flags = " ".join(tenancy["vulnerability_flags"]).lower()
    vulnerable = (("damp" in repair["type"] and any(w in flags for w in ("child", "respiratory", "asthma")))
                  or ("heating" in repair["type"] and "over 75" in flags))
    upheld = late > 0 or service_failure > 0
    vulnerability = 100 if vulnerable and upheld else 0
    total = late * rate + service_failure + vulnerability if upheld else 0
    return {"decision": "upheld" if upheld else "not_upheld", "target_date": target.isoformat(), "days_late": late,
            "daily_rate_gbp": rate, "delay_gbp": late * rate if upheld else 0, "service_failure_gbp": service_failure,
            "vulnerability_gbp": vulnerability, "total_gbp": total}


class AuditLog:
    """Append-only JSON lines. Each entry stores the hash of the one before, so changing or deleting an
    earlier entry breaks the chain and verify() says where."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)

    def entries(self) -> list[dict]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text().splitlines() if line.strip()]

    def append(self, entry: dict) -> dict:
        with self.lock:
            existing = self.entries()
            prev = existing[-1]["hash"] if existing else "0" * 16
            record = {"seq": len(existing) + 1, "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                      **entry, "prev": prev}
            record["hash"] = hashlib.sha256((prev + json.dumps(record, sort_keys=True, default=str)).encode()).hexdigest()[:16]
            with self.path.open("a") as f:
                f.write(json.dumps(record, default=str) + "\n")
            return record

    def verify(self) -> dict:
        prev = "0" * 16
        for e in self.entries():
            body = {k: v for k, v in e.items() if k != "hash"}
            ok = e["prev"] == prev and e["hash"] == hashlib.sha256((prev + json.dumps(body, sort_keys=True, default=str)).encode()).hexdigest()[:16]
            if not ok:
                return {"intact": False, "broken_at": e["seq"]}
            prev = e["hash"]
        return {"intact": True, "broken_at": None}


class CaseworkService:
    def __init__(self, gpt: Any, search: AzureSearch | None, spend: SpendTracker, folder: Path):
        self.gpt, self.search, self.spend = gpt, search, spend
        self.audit = AuditLog(folder / "audit.jsonl")
        self.runs: dict[str, dict] = {}
        self.sent: list[dict] = []  # the outbound system: letters actually sent
        self.lock = threading.Lock()
        self._indexed = False

    # Status and data ------------------------------------------------------------------------

    def model(self) -> str:
        if not self.gpt or not self.gpt.models:
            raise ApiError(503, "not_configured", "This lab needs a GPT deployment in Microsoft Foundry: set "
                                                  "AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENTS in .env.")
        return self.gpt.models[0]

    def info(self) -> dict:
        return {"ready": bool(self.gpt and self.gpt.models and self.search), "model": self.gpt.models[0] if self.gpt and self.gpt.models else None,
                "embedding": getattr(self.gpt, "embedding_deployment", "") if self.gpt else "",
                "search": self.search.endpoint if self.search else None, "index": INDEX,
                "prompts": {k: version(v) for k, v in PROMPTS.items()}, "gate": GATE,
                "cases": [{**c, "tenant": TENANCY[c["tenant_id"]]["name"],
                           "status": self._status(c["case_id"])} for c in CASES]}

    def _status(self, case_id: str) -> str:
        if any(s["case_id"] == case_id for s in self.sent):
            return "sent"
        runs = [r for r in self.runs.values() if r["case_id"] == case_id]
        return runs[-1]["status"] if runs else "new"

    def audit_trail(self, case_id: str | None = None) -> dict:
        entries = self.audit.entries()
        if case_id:
            entries = [e for e in entries if e.get("case_id") == case_id]
        return {"entries": entries, "chain": self.audit.verify()}

    # The policy index -------------------------------------------------------------------------

    def ensure_index(self) -> dict:
        """Create the index and load the policy chunks with their embeddings, once."""
        if self._indexed:
            return {"index": INDEX, "chunks": len(policy_chunks()), "created": False}
        if not self.search:
            raise ApiError(503, "not_configured", "Set AZURE_SEARCH_ENDPOINT in .env to use Azure AI Search.")
        chunks = policy_chunks()
        created = not self.search.index_exists(INDEX)
        if created:
            self.search.create_index({
                "name": INDEX,
                "fields": [
                    {"name": "id", "type": "Edm.String", "key": True, "filterable": True},
                    {"name": "title", "type": "Edm.String", "searchable": True, "filterable": True},
                    {"name": "section", "type": "Edm.String", "searchable": True},
                    {"name": "content", "type": "Edm.String", "searchable": True, "analyzer": "en.microsoft"},
                    {"name": "contentVector", "type": "Collection(Edm.Single)", "searchable": True,
                     "dimensions": DIMENSIONS, "vectorSearchProfile": "default"},
                ],
                "vectorSearch": {"algorithms": [{"name": "hnsw", "kind": "hnsw"}],
                                 "profiles": [{"name": "default", "algorithm": "hnsw"}]},
                "semantic": {"configurations": [{"name": SEMANTIC, "prioritizedFields": {
                    "titleField": {"fieldName": "section"}, "prioritizedContentFields": [{"fieldName": "content"}]}}]},
            })
        if created or self.search.count(INDEX) < len(chunks):
            vectors, usage = self.gpt.embed([f"{c['title']}: {c['section']}\n{c['content']}" for c in chunks])
            self.spend.charge(SimpleNamespace(usage=usage), self.gpt.embedding_deployment)
            self.search.upload(INDEX, [{**c, "contentVector": v} for c, v in zip(chunks, vectors)])
        self._indexed = True
        return {"index": INDEX, "chunks": len(chunks), "created": created}

    def retrieve(self, query: str, top: int = 4) -> list[dict]:
        vectors, usage = self.gpt.embed([query])
        self.spend.charge(SimpleNamespace(usage=usage), self.gpt.embedding_deployment)
        hits = self.search.hybrid(INDEX, query, vectors[0], top, ["id", "title", "section", "content"], SEMANTIC)
        return [{"id": h["id"], "title": h["title"], "section": h["section"], "content": h["content"],
                 "score": round(h.get("@search.score", 0), 4), "reranker": round(h.get("@search.rerankerScore") or 0, 2)}
                for h in hits]

    # Running a case -----------------------------------------------------------------------------

    def _ask(self, run: dict, agent: str, schema: dict, content: str, max_tokens: int = 4000) -> dict:
        model = self.model()
        message, usage = self.gpt.chat(model, [{"role": "system", "content": PROMPTS[agent]}, {"role": "user", "content": content}],
                                       schema=schema, max_tokens=max_tokens)
        run["cost"] += self.spend.charge(SimpleNamespace(usage=usage), model) or 0
        return json.loads(message.content or "{}")

    def _log(self, run: dict, actor: str, action: str, **detail: Any) -> None:
        self.audit.append({"case_id": run["case_id"], "run_id": run["run_id"], "actor": actor, "action": action, **detail})

    def run(self, case_id: str, record: bool = True) -> Iterator[dict]:
        """Works one case from intake to a draft awaiting approval, yielding each step as it finishes."""
        case = next((c for c in CASES if c["case_id"] == case_id), None)
        if case is None:
            raise ApiError(404, "not_found", f"No case {case_id}")
        model = self.model()
        self.ensure_index()
        run = {"run_id": uuid.uuid4().hex[:10], "case_id": case_id, "status": "running", "cost": 0.0, "steps": {}}
        if record:
            with self.lock:
                self.runs[run["run_id"]] = run
            self._log(run, "system", "run started", model=model, prompts={k: version(v) for k, v in PROMPTS.items()})
        log = self._log if record else (lambda *a, **k: None)

        # 1. Intake
        intake = self._ask(run, "intake", INTAKE_SCHEMA, f"Complaint received {case['received']} by {case['channel']}:\n{case['complaint']}")
        log(run, "agent:intake", "classified the complaint", model=model, prompt_version=version(INTAKE), output=intake)
        run["steps"]["intake"] = intake
        yield {"type": "step", "step": "intake", "data": intake}

        # 2. Evidence: a tool loop over the legacy systems
        messages: list[dict] = [{"role": "system", "content": EVIDENCE},
                                {"role": "user", "content": f"Case {case_id}, tenant {case['tenant_id']}.\nComplaint: {case['complaint']}\n"
                                                            f"Issues: {json.dumps(intake['issues'])}"}]
        calls = []
        for _ in range(6):
            message, usage = self.gpt.chat(model, messages, tools=TOOLS, schema=FACTS_SCHEMA, max_tokens=3000)
            run["cost"] += self.spend.charge(SimpleNamespace(usage=usage), model) or 0
            if not message.tool_calls:
                facts = json.loads(message.content or '{"facts": []}')["facts"]
                break
            messages.append({"role": "assistant", "content": message.content,
                             "tool_calls": [{"id": t.id, "type": "function", "function": {"name": t.function.name, "arguments": t.function.arguments}}
                                            for t in message.tool_calls]})
            for t in message.tool_calls:
                args = json.loads(t.function.arguments or "{}")
                result = call_tool(t.function.name, args)
                calls.append({"tool": t.function.name, "args": args, "result": result})
                log(run, f"tool:{t.function.name}", "read a system of record", input=args, output=result)
                messages.append({"role": "tool", "tool_call_id": t.id, "content": json.dumps(result)})
        else:
            raise ApiError(502, "too_many_steps", "The evidence agent did not finish within 6 tool rounds.")
        facts = [{"id": f"F{i}", **f} for i, f in enumerate(facts, 1)]
        log(run, "agent:evidence", "gathered facts", model=model, prompt_version=version(EVIDENCE), output=facts)
        run["steps"]["evidence"] = {"calls": calls, "facts": facts}
        yield {"type": "step", "step": "evidence", "data": run["steps"]["evidence"]}

        # 3. Policy retrieval: planned queries, hybrid search with semantic reranking
        fact_text = "\n".join(f"{f['id']}: {f['fact']}" for f in facts)
        plan = self._ask(run, "planner", PLAN_SCHEMA, f"Summary: {intake['summary']}\nFacts:\n{fact_text}", 1000)
        found: dict[str, dict] = {}
        searches = []
        for q in plan["queries"][:6]:
            hits = self.retrieve(q)
            searches.append({"query": q, "hits": [{"id": h["id"], "section": h["section"], "score": h["score"], "reranker": h["reranker"]} for h in hits]})
            for h in hits:
                found.setdefault(h["id"], h)
        policies = list(found.values())
        log(run, "search:azure-ai-search", "retrieved policy", model=model, prompt_version=version(PLANNER),
            input=plan["queries"], sources=[p["id"] for p in policies])
        run["steps"]["policy"] = {"queries": searches, "policies": policies}
        yield {"type": "step", "step": "policy", "data": run["steps"]["policy"]}

        # 4 and 5. Draft, check, and if the checks find problems, one revision with the findings, checked again.
        tenancy = TENANCY[case["tenant_id"]]
        case_record = [{"id": "CASE-1", "fact": f"Tenant {tenancy['name']}, {tenancy['address']}; preferred contact: {tenancy['preferred_contact']}; "
                                         f"complaint received {case['received']} by {case['channel']}; today's date {TODAY}."}]
        sources = {f["id"]: f["fact"] for f in case_record + facts} | {p["id"]: f"{p['section']}: {p['content']}" for p in policies}
        brief = (f"Case {case_id}. Complaint: {case['complaint']}\n\nFacts:\n"
                 + "\n".join(f"{f['id']}: {f['fact']}" for f in case_record + facts)
                 + "\n\nPolicy extracts:\n" + "\n\n".join(f"[{p['id']}] {p['title']}: {p['section']}\n{p['content']}" for p in policies))
        expected = rule_check(case)
        draft = self._ask(run, "drafter", DRAFT_SCHEMA, brief, 6000)
        for round_ in (1, 2):
            log(run, "agent:drafter", "drafted the decision and letter" if round_ == 1 else "revised the draft after the checks",
                model=model, prompt_version=version(DRAFTER if round_ == 1 else REVISE),
                output={k: draft[k] for k in ("decision", "compensation", "goodwill")}, sources=sorted({x for c in draft["claims"] for x in c["sources"]}))
            run["steps"]["draft" if round_ == 1 else "revision"] = draft
            yield {"type": "step", "step": "draft", "round": round_, "data": draft}
            checks = self._check(run, draft, sources, expected)
            log(run, "check:groundedness", f"{checks['supported']} of {checks['claims']} claims supported", model=model,
                prompt_version=version(VERIFIER), output=[v for v in checks["groundedness"] if not v["supported"]])
            log(run, "check:rules", "matches policy" if not checks["mismatches"] else f"differs on {', '.join(checks['mismatches'])}", output=expected)
            run["steps"]["checks"] = checks
            run["steps"]["first_checks" if round_ == 1 else "final_checks"] = checks
            yield {"type": "step", "step": "checks", "round": round_, "data": checks}
            if round_ == 2 or not checks["problems"]:
                break
            feedback = "Rule check (code, from the records and policy): " + json.dumps({k: expected[k] for k in checks["mismatches"]} | {"your_values": {k: (draft["decision"] if k == "decision" else draft["compensation"].get(k)) for k in checks["mismatches"]}}) \
                if checks["mismatches"] else "Rule check: matches."
            unsupported = [f"- {v['claim']}: {v['note']}" for v in checks["groundedness"] if not v["supported"]]
            feedback += "\nUnsupported claims:\n" + ("\n".join(unsupported) or "none") + (f"\nUnknown source ids: {checks['unknown_sources']}" if checks["unknown_sources"] else "")
            draft = self._ask(run, "revise", DRAFT_SCHEMA, f"{brief}\n\nYour draft:\n{json.dumps(draft)}\n\nCheck findings:\n{feedback}", 6000)
        run["steps"]["draft"] = draft
        run["status"] = "awaiting approval"
        yield {"type": "done", "run_id": run["run_id"], "status": run["status"], "cost": round(run["cost"], 5)}

    def _check(self, run: dict, draft: dict, sources: dict[str, str], expected: dict) -> dict:
        """Groundedness by a separate model call; the decision and figures recomputed by code."""
        claims_text = "\n\n".join(f"Claim {i}: {c['claim']}\nCited: " + "; ".join(f"[{x}] {sources.get(x, '(unknown id)')}" for x in c["sources"])
                                  for i, c in enumerate(draft["claims"], 1))
        verdict = self._ask(run, "verifier", VERIFY_SCHEMA, claims_text or "No claims.", 4000)["results"] if draft["claims"] else []
        unknown = sorted({x for c in draft["claims"] for x in c["sources"] if x not in sources})
        mismatches = [k for k in ("decision", "days_late", "delay_gbp", "service_failure_gbp", "vulnerability_gbp", "total_gbp")
                      if (draft["decision"] if k == "decision" else draft["compensation"].get(k)) != expected[k]]
        supported = sum(v["supported"] for v in verdict)
        return {"groundedness": verdict, "supported": supported, "claims": len(verdict), "unknown_sources": unknown,
                "rules": expected, "mismatches": mismatches, "problems": bool(mismatches or unknown or supported < len(verdict))}

    def stream(self, case_id: str) -> Iterator[str]:
        """run() as NDJSON lines, with failures reported in the stream."""
        try:
            for event in self.run(case_id):
                yield json.dumps(event) + "\n"
        except ApiError as exc:
            yield json.dumps({"type": "error", "message": exc.message}) + "\n"
        except Exception as exc:  # a crash mid-stream still ends the stream readably
            yield json.dumps({"type": "error", "message": f"{type(exc).__name__}: {exc}"}) + "\n"

    # The human decision --------------------------------------------------------------------------

    def decide(self, run_id: str, action: str, reviewer: str, letter: str, note: str) -> dict:
        with self.lock:
            run = self.runs.get(run_id)
            if run is None:
                raise ApiError(404, "not_found", "No such run. Run the agents again.")
            if run["status"] != "awaiting approval":
                raise ApiError(409, "already_decided", f"This draft was already {run['status']}.")
            draft, checks = run["steps"]["draft"], run["steps"]["checks"]
            if action == "approve" and checks["problems"] and not note.strip():
                raise ApiError(400, "note_required", "The checks found problems. Fix the letter or give a reason for approving it anyway.")
            edited = letter.strip() != draft["letter"].strip()
            run["status"] = "sent" if action == "approve" else "rejected"
        if action == "approve":
            tenancy = TENANCY[next(c for c in CASES if c["case_id"] == run["case_id"])["tenant_id"]]
            self.sent.append({"case_id": run["case_id"], "run_id": run_id, "to": tenancy["name"], "via": tenancy["preferred_contact"],
                              "letter": letter.strip(), "approved_by": reviewer})
        self._log(run, f"human:{reviewer}", "approved and sent the response" if action == "approve" else "rejected the draft",
                  output={"edited": edited, "note": note.strip(), "decision": draft["decision"],
                          "total_gbp": draft["compensation"]["total_gbp"]},
                  letter_sha=hashlib.sha256(letter.strip().encode()).hexdigest()[:16])
        return {"status": run["status"], "edited": edited}

    # Release gate ------------------------------------------------------------------------------

    def evaluate(self) -> Iterator[str]:
        """Runs the pipeline over the gold set (without recording) and checks the release thresholds."""
        rows, total_cost = [], 0.0
        try:
            for case in CASES:
                result: dict[str, dict] = {}
                for event in self.run(case["case_id"], record=False):
                    if event["type"] == "step":
                        result[f"{event['step']}{event.get('round', '')}"] = event["data"]
                    if event["type"] == "done":
                        total_cost += event["cost"]
                want = EXPECTED[case["case_id"]]
                first, final = result["draft1"], result.get("draft2", result["draft1"])
                checks = result.get("checks2", result["checks1"])
                row = {"case_id": case["case_id"], "expected": want, "revised": "draft2" in result,
                       "first": {"decision": first["decision"], "total_gbp": first["compensation"]["total_gbp"]},
                       "decision": final["decision"], "total_gbp": final["compensation"]["total_gbp"],
                       "first_ok": first["decision"] == want["decision"] and first["compensation"]["total_gbp"] == want["compensation_gbp"],
                       "decision_ok": final["decision"] == want["decision"],
                       "compensation_ok": final["compensation"]["total_gbp"] == want["compensation_gbp"],
                       "supported": checks["supported"], "claims": checks["claims"]}
                rows.append(row)
                yield json.dumps({"type": "case", "row": row}) + "\n"
            claims = sum(r["claims"] for r in rows) or 1
            metrics = {"first_draft_accuracy": sum(r["first_ok"] for r in rows) / len(rows),
                       "decision_accuracy": sum(r["decision_ok"] for r in rows) / len(rows),
                       "compensation_accuracy": sum(r["compensation_ok"] for r in rows) / len(rows),
                       "groundedness": sum(r["supported"] for r in rows) / claims}
            passed = all(metrics[k] >= GATE[k] for k in GATE)
            self.audit.append({"case_id": None, "run_id": None, "actor": "system", "action": "evaluation",
                               "model": self.model(), "prompts": {k: version(v) for k, v in PROMPTS.items()},
                               "output": {**metrics, "passed": passed}})
            yield json.dumps({"type": "done", "metrics": metrics, "gate": GATE, "passed": passed, "cost": round(total_cost, 5)}) + "\n"
        except ApiError as exc:
            yield json.dumps({"type": "error", "message": exc.message}) + "\n"
