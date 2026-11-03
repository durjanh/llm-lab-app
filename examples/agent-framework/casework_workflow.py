"""The council complaint flow from Lab 25, rebuilt with Microsoft Agent Framework and run in DevUI.

Same prompts, data, tools, Azure AI Search index and rule check as backend/app/services/casework.py,
so the two can be compared like for like. What changes is the orchestration:

- five Agent Framework agents on Azure OpenAI (OpenAIChatCompletionClient, Entra sign-in, no keys),
  each with a typed structured output (pydantic);
- the evidence agent's systems of record are @tool functions, which the framework calls in its own loop;
- the steps are executors in a workflow graph, with a conditional loop edge back to the drafter when the
  checks find problems;
- the caseworker's approval is a real pause in the workflow (request_info): DevUI shows a form for it,
  and the workflow resumes with the decision;
- every step goes into the same hash-chained audit log, in its own file.

    python examples/agent-framework/casework_workflow.py                    # DevUI at http://127.0.0.1:8090
    python examples/agent-framework/casework_workflow.py --case C-304 --approve-as "Sam Patel"   # no UI
"""
from __future__ import annotations

import argparse
import asyncio
import contextvars
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "python"))
import common  # noqa: E402,F401  (reads .env)
from agent_framework import Agent, Executor, WorkflowBuilder, WorkflowContext, handler, response_handler, tool  # noqa: E402
from agent_framework.openai import OpenAIChatCompletionClient  # noqa: E402
from azure.identity import DefaultAzureCredential  # noqa: E402
from typing_extensions import Never  # noqa: E402

from backend.app.gateways.azure_openai import AzureOpenAI  # noqa: E402
from backend.app.gateways.azure_search import AzureSearch  # noqa: E402
from backend.app.services.casework import (DRAFTER, EVIDENCE, INDEX, INTAKE, PLANNER, REVISE, SEMANTIC, VERIFIER,  # noqa: E402
                                           AuditLog, call_tool, rule_check, version)
from backend.app.services.casework_data import CASES, TENANCY, TODAY  # noqa: E402

MODEL = os.environ.get("AZURE_OPENAI_DEPLOYMENTS", "gpt-5.4-mini").split(",")[0].strip()
AUDIT = AuditLog(ROOT / "casework" / "agent-framework-audit.jsonl")
CURRENT: contextvars.ContextVar[dict] = contextvars.ContextVar("current_case", default={})  # for the tools' audit lines


# --- Typed outputs: each agent's answer is validated into one of these ---------------------------

class Intake(BaseModel):
    summary: str
    category: Literal["repairs", "communication", "staff conduct", "other"]
    issues: list[str]
    resident_wants: list[str]
    vulnerability_mentioned: str


class Fact(BaseModel):
    fact: str
    source: Literal["tenancy", "repairs", "contacts", "complaint"]


class Facts(BaseModel):
    facts: list[Fact]


class Plan(BaseModel):
    queries: list[str]


class Compensation(BaseModel):
    target_date: str
    days_late: int
    daily_rate_gbp: int
    delay_gbp: int
    service_failure_gbp: int
    vulnerability_gbp: int
    total_gbp: int
    working: str


class Claim(BaseModel):
    claim: str
    sources: list[str]


class Draft(BaseModel):
    decision: Literal["upheld", "partly_upheld", "not_upheld"]
    reasons: str
    compensation: Compensation
    goodwill: str
    letter: str
    claims: list[Claim]


class ClaimVerdict(BaseModel):
    claim: str
    supported: bool
    note: str


class Verdict(BaseModel):
    results: list[ClaimVerdict]


# --- Messages between executors, and the human-in-the-loop request ----------------------------------

class CaseRequest(BaseModel):
    """The workflow's input: which complaint to work. DevUI shows this as the start form."""
    case_id: Literal["C-301", "C-302", "C-303", "C-304", "C-305"] = Field(description="Complaint to handle")


class CaseFile(BaseModel):
    """Everything known about the case so far, passed from step to step."""
    case_id: str
    run_id: str
    complaint: str
    tenant: str
    intake: Intake | None = None
    facts: list[dict] = []
    policies: list[dict] = []
    draft: Draft | None = None
    round: int = 0
    feedback: str = ""
    checks: dict = {}


class ApprovalRequest(BaseModel):
    """What the caseworker sees when the workflow pauses for them."""
    case_id: str
    run_id: str
    tenant: str
    decision: str
    compensation_gbp: int
    letter: str
    checks: str
    problems: bool


class CaseworkerDecision(BaseModel):
    """Approve or reject the drafted response. Your name and decision are recorded in the audit log."""
    action: Literal["approve", "reject"]
    reviewer: str = Field(min_length=2, description="Your name, recorded in the audit log")
    note: str = Field(default="", description="Required when approving a draft the checks found problems with")
    letter: str = Field(default="", description="Leave empty to send the drafted letter unchanged")


class CaseOutcome(BaseModel):
    case_id: str
    status: Literal["sent", "rejected"]
    reviewer: str
    letter: str
    audit_entries: int
    audit_chain_intact: bool


def audit(cf: CaseFile | ApprovalRequest, actor: str, action: str, **detail: Any) -> None:
    AUDIT.append({"case_id": cf.case_id, "run_id": cf.run_id, "actor": actor, "action": action, "framework": "agent-framework", **detail})


# --- The systems of record, as Agent Framework tools ------------------------------------------------

def _read(name: str, args: dict) -> str:
    result = call_tool(name, args)
    cur = CURRENT.get()
    AUDIT.append({"case_id": cur.get("case_id"), "run_id": cur.get("run_id"), "actor": f"tool:{name}",
                  "action": "read a system of record", "framework": "agent-framework", "input": args, "output": result})
    return json.dumps(result)


@tool(description="The tenancy record: tenant, address, property id, household and recorded vulnerabilities.")
def get_tenancy(tenant_id: str) -> str:
    """tenant_id: such as T-1042"""
    return _read("get_tenancy", {"tenant_id": tenant_id})


@tool(description="Repair jobs for a property: type, priority, reported and completed dates, target days, notes.")
def get_repairs(property_id: str) -> str:
    """property_id: such as P-881"""
    return _read("get_repairs", {"property_id": property_id})


@tool(description="The resident's contacts with the council about this case, and whether each was replied to.")
def get_contact_history(case_id: str) -> str:
    """case_id: such as C-301"""
    return _read("get_contact_history", {"case_id": case_id})


# --- Agents ----------------------------------------------------------------------------------------

def client() -> OpenAIChatCompletionClient:
    return OpenAIChatCompletionClient(model=MODEL, azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
                                      credential=DefaultAzureCredential())


def agents() -> dict[str, Agent]:
    c = client()
    return {
        "intake": Agent(c, INTAKE, name="intake"),
        "evidence": Agent(c, EVIDENCE, name="evidence", tools=[get_tenancy, get_repairs, get_contact_history]),
        "planner": Agent(c, PLANNER, name="planner"),
        "drafter": Agent(c, DRAFTER, name="drafter"),
        "reviser": Agent(c, REVISE, name="reviser"),
        "verifier": Agent(c, VERIFIER, name="verifier"),
    }


async def ask(agent: Agent, prompt: str, schema: type[BaseModel]) -> Any:
    response = await agent.run(prompt, options={"response_format": schema})
    return response.value


# --- Executors: the steps of the workflow ---------------------------------------------------------

class IntakeStep(Executor):
    def __init__(self, team: dict[str, Agent]):
        super().__init__(id="intake")
        self.team = team

    @handler
    async def start(self, request: CaseRequest, ctx: WorkflowContext[CaseFile]) -> None:
        case = next(c for c in CASES if c["case_id"] == request.case_id)
        cf = CaseFile(case_id=case["case_id"], run_id=uuid.uuid4().hex[:10], complaint=case["complaint"],
                      tenant=TENANCY[case["tenant_id"]]["name"])
        audit(cf, "system", "run started", model=MODEL)
        cf.intake = await ask(self.team["intake"], f"Complaint received {case['received']} by {case['channel']}:\n{case['complaint']}", Intake)
        audit(cf, "agent:intake", "classified the complaint", model=MODEL, prompt_version=version(INTAKE), output=cf.intake.model_dump())
        await ctx.send_message(cf)


class EvidenceStep(Executor):
    def __init__(self, team: dict[str, Agent]):
        super().__init__(id="evidence")
        self.team = team

    @handler
    async def gather(self, cf: CaseFile, ctx: WorkflowContext[CaseFile]) -> None:
        case = next(c for c in CASES if c["case_id"] == cf.case_id)
        CURRENT.set({"case_id": cf.case_id, "run_id": cf.run_id})  # so the tools' reads are audited under this case
        facts = await ask(self.team["evidence"], f"Case {cf.case_id}, tenant {case['tenant_id']}.\nComplaint: {cf.complaint}\n"
                                                 f"Issues: {json.dumps(cf.intake.issues)}", Facts)
        cf.facts = [{"id": f"F{i}", **f.model_dump()} for i, f in enumerate(facts.facts, 1)]
        audit(cf, "agent:evidence", "gathered facts", model=MODEL, prompt_version=version(EVIDENCE), output=cf.facts)
        await ctx.send_message(cf)


class PolicyStep(Executor):
    def __init__(self, team: dict[str, Agent]):
        super().__init__(id="policy_search")
        self.team = team
        self.search = AzureSearch(os.environ["AZURE_SEARCH_ENDPOINT"])
        self.embeddings = AzureOpenAI(os.environ["AZURE_OPENAI_ENDPOINT"], [MODEL], os.environ["AZURE_OPENAI_EMBEDDING_DEPLOYMENT"])

    @handler
    async def retrieve(self, cf: CaseFile, ctx: WorkflowContext[CaseFile]) -> None:
        fact_text = "\n".join(f"{f['id']}: {f['fact']}" for f in cf.facts)
        plan = await ask(self.team["planner"], f"Summary: {cf.intake.summary}\nFacts:\n{fact_text}", Plan)
        found: dict[str, dict] = {}
        for q in plan.queries[:6]:
            vectors, _ = await asyncio.to_thread(self.embeddings.embed, [q])
            hits = await asyncio.to_thread(self.search.hybrid, INDEX, q, vectors[0], 4, ["id", "title", "section", "content"], SEMANTIC)
            for h in hits:
                found.setdefault(h["id"], {k: h[k] for k in ("id", "title", "section", "content")})
        cf.policies = list(found.values())
        audit(cf, "search:azure-ai-search", "retrieved policy", model=MODEL, prompt_version=version(PLANNER),
              input=plan.queries, sources=[p["id"] for p in cf.policies])
        await ctx.send_message(cf)


def brief(cf: CaseFile) -> str:
    t = next(TENANCY[c["tenant_id"]] for c in CASES if c["case_id"] == cf.case_id)
    case = next(c for c in CASES if c["case_id"] == cf.case_id)
    record = (f"CASE-1: Tenant {t['name']}, {t['address']}; preferred contact: {t['preferred_contact']}; "
              f"complaint received {case['received']} by {case['channel']}; today's date {TODAY}.")
    return (f"Case {cf.case_id}. Complaint: {cf.complaint}\n\nFacts:\n{record}\n" + "\n".join(f"{f['id']}: {f['fact']}" for f in cf.facts)
            + "\n\nPolicy extracts:\n" + "\n\n".join(f"[{p['id']}] {p['title']}: {p['section']}\n{p['content']}" for p in cf.policies))


class DraftStep(Executor):
    def __init__(self, team: dict[str, Agent]):
        super().__init__(id="draft")
        self.team = team

    @handler
    async def draft(self, cf: CaseFile, ctx: WorkflowContext[CaseFile]) -> None:
        cf.round += 1
        if cf.round == 1:
            cf.draft = await ask(self.team["drafter"], brief(cf), Draft)
        else:  # back from the checks with findings: one revision
            cf.draft = await ask(self.team["reviser"], f"{brief(cf)}\n\nYour draft:\n{cf.draft.model_dump_json()}\n\nCheck findings:\n{cf.feedback}", Draft)
        audit(cf, "agent:drafter", "drafted the decision and letter" if cf.round == 1 else "revised the draft after the checks",
              model=MODEL, prompt_version=version(DRAFTER if cf.round == 1 else REVISE),
              output={"decision": cf.draft.decision, "compensation": cf.draft.compensation.model_dump()})
        await ctx.send_message(cf)


class CheckStep(Executor):
    """Groundedness by a separate agent; decision and compensation recomputed by code."""

    def __init__(self, team: dict[str, Agent]):
        super().__init__(id="checks")
        self.team = team

    @handler
    async def check(self, cf: CaseFile, ctx: WorkflowContext[CaseFile]) -> None:
        case = next(c for c in CASES if c["case_id"] == cf.case_id)
        t = TENANCY[case["tenant_id"]]
        sources = {"CASE-1": f"Tenant {t['name']}, preferred contact {t['preferred_contact']}; received {case['received']}; today {TODAY}"}
        sources |= {f["id"]: f["fact"] for f in cf.facts} | {p["id"]: f"{p['section']}: {p['content']}" for p in cf.policies}
        claims = "\n\n".join(f"Claim {i}: {c.claim}\nCited: " + "; ".join(f"[{s}] {sources.get(s, '(unknown id)')}" for s in c.sources)
                             for i, c in enumerate(cf.draft.claims, 1))
        verdict = await ask(self.team["verifier"], claims or "No claims.", Verdict)
        expected = rule_check(case)
        mismatches = [k for k in ("decision", "days_late", "delay_gbp", "service_failure_gbp", "vulnerability_gbp", "total_gbp")
                      if (cf.draft.decision if k == "decision" else getattr(cf.draft.compensation, k)) != expected[k]]
        unsupported = [v for v in verdict.results if not v.supported]
        cf.checks = {"supported": len(verdict.results) - len(unsupported), "claims": len(verdict.results), "mismatches": mismatches,
                     "unsupported": [v.model_dump() for v in unsupported], "rules": expected}
        problems = bool(mismatches or unsupported)
        audit(cf, "check:groundedness", f"{cf.checks['supported']} of {cf.checks['claims']} claims supported", model=MODEL,
              prompt_version=version(VERIFIER), output=cf.checks["unsupported"])
        audit(cf, "check:rules", "matches policy" if not mismatches else f"differs on {', '.join(mismatches)}", output=expected)
        cf.feedback = ""
        if problems and cf.round == 1:
            cf.feedback = ("Rule check (code, from the records and policy): " + json.dumps({k: expected[k] for k in mismatches})
                           if mismatches else "Rule check: matches.") + "\nUnsupported claims:\n" + ("\n".join(
                               f"- {v.claim}: {v.note}" for v in unsupported) or "none")
        cf.checks["problems"] = problems
        await ctx.send_message(cf)  # the edges decide: back to the drafter, or on to the caseworker


class ApprovalStep(Executor):
    """The workflow stops here until a named caseworker answers."""

    def __init__(self) -> None:
        super().__init__(id="caseworker_approval")

    @handler
    async def ask_caseworker(self, cf: CaseFile, ctx: WorkflowContext) -> None:
        c = cf.checks
        summary = (f"{c['supported']}/{c['claims']} claims grounded; rule check "
                   + ("matches" if not c["mismatches"] else f"differs on {', '.join(c['mismatches'])}") + f"; rounds: {cf.round}")
        audit(cf, "system", "waiting for caseworker approval")
        await ctx.request_info(ApprovalRequest(case_id=cf.case_id, run_id=cf.run_id, tenant=cf.tenant, decision=cf.draft.decision,
                                               compensation_gbp=cf.draft.compensation.total_gbp, letter=cf.draft.letter,
                                               checks=summary, problems=c["problems"]), CaseworkerDecision)

    @response_handler
    async def on_decision(self, request: ApprovalRequest, decision: CaseworkerDecision, ctx: WorkflowContext[Never, CaseOutcome]) -> None:
        if decision.action == "approve" and request.problems and not decision.note.strip():
            decision = CaseworkerDecision(action="reject", reviewer=decision.reviewer,
                                          note="Not sent: the checks found problems and no reason was given for approving.")
        letter = decision.letter.strip() or request.letter
        audit(request, f"human:{decision.reviewer}", "approved and sent the response" if decision.action == "approve" else "rejected the draft",
              output={"edited": bool(decision.letter.strip()), "note": decision.note, "decision": request.decision,
                      "total_gbp": request.compensation_gbp})
        await ctx.yield_output(CaseOutcome(case_id=request.case_id, status="sent" if decision.action == "approve" else "rejected",
                                           reviewer=decision.reviewer, letter=letter if decision.action == "approve" else "",
                                           audit_entries=len(AUDIT.entries()), audit_chain_intact=AUDIT.verify()["intact"]))


def build_workflow(team: dict[str, Agent] | None = None):
    team = team or agents()
    intake, evidence, policy, draft, checks, approval = (IntakeStep(team), EvidenceStep(team), PolicyStep(team), DraftStep(team),
                                                         CheckStep(team), ApprovalStep())
    return (WorkflowBuilder(start_executor=intake, name="Council complaint handling",
                            description="Agents draft a Stage 1 complaint response; checks; one revision; a caseworker approves.")
            .add_edge(intake, evidence)
            .add_edge(evidence, policy)
            .add_edge(policy, draft)
            .add_edge(draft, checks)
            .add_edge(checks, draft, condition=lambda cf: bool(cf.feedback))        # problems on the first draft: revise once
            .add_edge(checks, approval, condition=lambda cf: not cf.feedback)       # otherwise: to the caseworker
            .build())


async def run_headless(case_id: str, reviewer: str) -> None:
    """Runs one case without DevUI, answering the approval request as the given caseworker."""
    workflow = build_workflow()
    result = await workflow.run(CaseRequest(case_id=case_id))
    requests = result.get_request_info_events()
    for r in requests:
        req: ApprovalRequest = r.data
        print(f"Waiting for approval: {req.case_id} {req.decision} £{req.compensation_gbp} ({req.checks})")
    answers = {r.request_id: CaseworkerDecision(action="approve", reviewer=reviewer, note="Approved from the command line")
               for r in requests}
    result = await workflow.run(responses=answers)
    for out in result.get_outputs():
        print(out.model_dump_json(indent=2) if isinstance(out, BaseModel) else out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--case", help="run one case without the UI, e.g. C-301")
    parser.add_argument("--approve-as", default="Command line", help="the caseworker name used with --case")
    parser.add_argument("--port", type=int, default=8090)
    args = parser.parse_args()
    if args.case:
        asyncio.run(run_headless(args.case, args.approve_as))
        return
    from agent_framework.devui import serve

    # Local only: DevUI binds to 127.0.0.1, so its token auth is switched off for convenience.
    serve(entities=[build_workflow()], port=args.port, host="127.0.0.1", auto_open=False,
          instrumentation_enabled=True, auth_enabled=False)


if __name__ == "__main__":
    main()
