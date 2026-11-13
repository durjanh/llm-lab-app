"""The delivery page's design tool: a model turns a short business brief into a structured solution design (the
requirements, the pattern, components, value measures, risks, an evaluation plan, SLAs and an ADR draft). Code checks
the answer has every section and that the pattern is one of the three, and sends the problems back once for a second
try.
"""
from __future__ import annotations

import json
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, text_of
from .spend import SpendTracker

PATTERNS = ("augmented_llm", "workflow", "agent")
PILLARS = ("efficiency", "transformation", "productivity", "cost", "performance_slas")
MECHANISMS = ("mcp", "direct_api", "cli", "a2a", "none")
MAX_BRIEF = 4000

_STR = {"type": "string"}
_STRS = {"type": "array", "items": _STR}


def _obj(**props: Any) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


def _list(item: dict[str, Any]) -> dict[str, Any]:
    return {"type": "array", "items": item}


SCHEMA: dict[str, Any] = _obj(
    summary=_STR,
    requirements=_obj(functional=_STRS, infrastructure=_STRS, success_measures=_STRS),
    pattern=_obj(choice={"type": "string", "enum": list(PATTERNS)}, reasons=_STRS, would_change_if=_STRS),
    components=_obj(
        model=_obj(choice=_STR, reasons=_STRS),
        retrieval=_STR,
        tools=_list(_obj(name=_STR, purpose=_STR, mechanism={"type": "string", "enum": list(MECHANISMS)},
                         why=_STR)),
        guardrails=_STRS),
    value=_list(_obj(pillar={"type": "string", "enum": list(PILLARS)}, claim=_STR, measure=_STR)),
    # Three-part rows are "a | b | c" strings: Claude's structured output refuses a schema with this many nested
    # objects ("the compiled grammar is too large"), so code splits them back into rows (see unflatten).
    risks=_STRS,
    compliance=_STRS,
    authn_authz=_STRS,
    evaluation=_obj(accuracy=_STR, latency=_STR, cost=_STR, safety=_STR, dataset=_STR, ab_test=_STR),
    slas=_STRS,
    open_questions=_STRS,
    adr=_obj(title=_STR, status=_STR, context=_STR, decision=_STR, alternatives=_STRS, consequences=_STRS),
)

SYSTEM = """You are a solutions architect for Claude-based systems. A person pastes a short business brief. You return
a first-pass design as JSON in the given schema. Rules:
- Pick the simplest pattern that meets the need. augmented_llm is one model call with retrieval or tools; workflow is
  fixed, code-controlled steps; agent is a model that decides its own steps. Say what would change the decision.
- Split requirements into functional (what it does) and infrastructure (latency, volume, residency, availability,
  integration, identity). Give success measures a team could check.
- Components: a model choice with reasons (capability, latency, cost), how knowledge is retrieved, each tool with an
  integration mechanism (mcp, direct_api, cli, a2a or none) and why. Keep the tool list short; least privilege.
- Value: cover the pillars that matter (efficiency, transformation, productivity, cost, performance_slas), each with a
  measurable figure to track. Do not invent savings; say what to measure and the baseline needed.
- Risks and failure modes, each with a mitigation and where a human stays in the loop.
- Compliance: name regulations that may apply (for example GDPR, HIPAA, FedRAMP, FCA rules, PCI DSS) and why. Do not
  claim what any vendor offers; say what to check with the vendor's sales and legal teams.
- Authn/authz: per-user identity, scoped tokens, service accounts, secrets handling.
- Evaluation plan: accuracy, latency, cost and safety metrics, a dataset, how to A/B test.
- SLAs the team could commit to, open questions for stakeholders, and an ADR draft for the main decision.
- Write each risk as "risk | mitigation | where a person stays in the loop", each compliance item as
  "regulation | why it may apply | what to check", and each SLA as "name | target | how it is measured": three parts
  separated by " | ".
Write plain British English: short sentences, no marketing tone. Every list needs at least one item."""

_REQUIRED = ("summary", "requirements", "pattern", "components", "value", "risks", "compliance", "authn_authz",
             "evaluation", "slas", "open_questions", "adr")


_ROWS = {"risks": ("risk", "mitigation", "human_in_the_loop"),
         "compliance": ("regulation", "why_it_may_apply", "what_to_check"),
         "slas": ("name", "target", "how_measured")}


def unflatten(design: dict[str, Any]) -> dict[str, Any]:
    """The model's flat reply in the page's shape: "a | b | c" rows become objects, and the four metrics are grouped."""
    out = dict(design)
    for key, fields in _ROWS.items():
        rows = []
        for item in design.get(key) or []:
            if isinstance(item, dict):
                rows.append(item)
                continue
            parts = [x.strip() for x in str(item).split("|")]
            parts = parts[:len(fields) - 1] + [" | ".join(parts[len(fields) - 1:])] if len(parts) > len(fields) else parts
            rows.append({f: parts[i] if i < len(parts) else "" for i, f in enumerate(fields)})
        out[key] = rows
    ev = design.get("evaluation")
    if isinstance(ev, dict) and "metrics" not in ev:
        out["evaluation"] = {"metrics": {k: ev.get(k, "") for k in ("accuracy", "latency", "cost", "safety")},
                             "dataset": ev.get("dataset", ""), "ab_test": ev.get("ab_test", "")}
    return out


def problems(design: Any) -> list[str]:
    """What is wrong with a design, in words the model can act on. Empty when it can be shown."""
    if not isinstance(design, dict):
        return ["The reply was not a JSON object."]
    found = [f"Section '{k}' is missing or empty." for k in _REQUIRED if not design.get(k)]
    pattern = design.get("pattern")
    choice = pattern.get("choice") if isinstance(pattern, dict) else None
    if pattern and choice not in PATTERNS:
        found.append(f"pattern.choice is {choice!r}; it must be one of {', '.join(PATTERNS)}.")
    if isinstance(pattern, dict) and pattern and not pattern.get("reasons"):
        found.append("pattern.reasons is empty.")
    req = design.get("requirements")
    if isinstance(req, dict):
        for k in ("functional", "infrastructure", "success_measures"):
            if not req.get(k):
                found.append(f"requirements.{k} is empty.")
    seen = {v.get("pillar") for v in design.get("value") or [] if isinstance(v, dict)}
    bad = [p for p in seen if p not in PILLARS]
    if bad:
        found.append(f"value pillar {bad[0]!r} is not one of {', '.join(PILLARS)}.")
    for i, t in enumerate((design.get("components") or {}).get("tools") or []):
        if isinstance(t, dict) and t.get("mechanism") not in MECHANISMS:
            found.append(f"components.tools[{i}].mechanism must be one of {', '.join(MECHANISMS)}.")
    adr = design.get("adr")
    if isinstance(adr, dict) and adr and not (adr.get("decision") and adr.get("context")):
        found.append("adr needs a context and a decision.")
    return found[:12]


class DeliveryService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker):
        self.claude, self.spend = claude, spend

    def design(self, brief: str, model: str | None) -> dict[str, Any]:
        model = model or DEFAULT_MODEL
        messages: list[dict[str, Any]] = [{"role": "user", "content": "Business brief:\n\n" + brief[:MAX_BRIEF]}]
        cost, tries = 0.0, []
        for attempt in (1, 2):
            try:
                response = self.claude.create(model=model, max_tokens=12000, system=SYSTEM, messages=messages,
                                              output_config={"format": {"type": "json_schema", "schema": SCHEMA}})
            except Exception as exc:
                raise to_api_error(exc) from exc
            cost += self.spend.charge(response, model) or 0.0
            if response.stop_reason == "refusal":
                raise ApiError(502, "refused", "The model declined to design for this brief. Try rewording it.")
            raw = text_of(response)
            try:
                design = json.loads(raw)
            except ValueError:
                design = None
            found = problems(design)
            if response.stop_reason == "max_tokens":
                found = ["The reply was cut off before it finished. Keep each list short.", *found][:12]
            tries.append({"attempt": attempt, "problems": found})
            if not found:
                return {"design": unflatten(design), "tries": tries, "cost_usd": round(cost, 6), "model": model}
            # The API refuses an empty assistant turn, so an empty reply is named rather than sent as "".
            messages += [{"role": "assistant", "content": raw or f"(No text: stop_reason {response.stop_reason}.)"},
                         {"role": "user", "content": "The design has problems:\n- " + "\n- ".join(found)
                          + "\nFix these and send the whole design again."}]
        raise ApiError(502, "invalid_design", "The model's design still had problems after a second try: "
                                              + " ".join(tries[-1]["problems"][:3]))
