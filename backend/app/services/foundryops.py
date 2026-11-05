"""Foundry operations: what is deployed, quotas, rate limits, metrics, security, evaluations and tracing.

Everything about the resources is read from Azure Resource Manager and Azure Monitor (read only), so the page
shows this lab's real deployments, not a diagram. Evaluations score a small labelled set with LLM-judge
evaluators (groundedness, relevance, coherence), a code evaluator (token F1 against the reference answer) and
Content Safety's groundedness detection, then apply a release gate. Tracing records one retrieval-augmented
answer with OpenTelemetry, using the generative AI semantic conventions, as Foundry tracing does.
"""
from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..core.errors import ApiError
from ..gateways.azure_search import AzureSearch
from ..gateways.foundry_tools import FoundryTools
from ..shared import PRICES, ROOT, TOOL_PRICES
from . import search_samples
from .spend import SpendTracker

JUDGE = "gpt-5.4-mini"
METRICS = ["AzureOpenAIRequests", "ProcessedPromptTokens", "GeneratedTokens", "AzureOpenAITimeToResponse", "Ratelimit", "BlockedCalls"]
DEPLOYMENT_TYPES = [
    ("Global Standard", "Pay per token; Microsoft routes each request to any region with capacity.", "Most workloads: highest quota, lowest price, data may be processed outside your geography."),
    ("Data Zone Standard", "Pay per token; processing stays in a data zone (the EU or the US).", "Data residency within a zone, near-global capacity."),
    ("Standard (regional)", "Pay per token; processing stays in the resource's region.", "Strict residency in one region; lower quotas, fewer models."),
    ("Provisioned (PTU), global, data zone or regional", "Reserved throughput units, billed hourly or by reservation.", "Steady high volume and predictable latency; pays off above a usage threshold."),
    ("Global Batch", "Asynchronous jobs within 24 hours, about half the Global Standard price.", "Large offline jobs: evaluations, back-fills, classification of a backlog."),
    ("Developer", "Pay per token for fine-tuned models, no hosting fee, no SLA.", "Trying fine-tuned models before paying to host them."),
]
EVAL_SET = [  # question, context (policy section), the response under test, the reference answer
    ("What is the excess for escape of water?", "policy-escape", "The excess for escape of water claims is £350.", "£350"),
    ("Do I pay an excess for trace and access?", "policy-trace", "No. Trace and access has no separate excess, and pays up to £5,000 per claim.", "No separate excess; up to £5,000"),
    ("How soon must I report a claim?", "policy-claims", "Within 30 days, and ideally as soon as you can.", "As soon as you can and within 30 days"),
    ("Is a slow drip covered?", "policy-exclusions", "Yes, all water damage is covered including slow drips over several months.", "No, gradual escapes are not covered"),
    ("How long can I stay in a hotel?", "policy-accommodation", "Our call centre is open from 8am to 8pm on weekdays.", "Up to £20,000 or 12 months"),
    ("Can I cancel and get a refund?", "policy-cancel", "Cancel within 14 days for a full refund if no claim; after that a pro-rata refund less £25.", "Within 14 days, full refund if no claim; then pro rata less £25"),
]
JUDGE_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["groundedness", "relevance", "coherence", "reason"],
                "properties": {"groundedness": {"type": "integer", "description": "1 to 5: is every claim in the response supported by the context"},
                               "relevance": {"type": "integer", "description": "1 to 5: does the response answer the question asked"},
                               "coherence": {"type": "integer", "description": "1 to 5: is it clear, logical and well formed"},
                               "reason": {"type": "string", "description": "one sentence"}}}
GATE = {"groundedness": 4.0, "relevance": 4.0, "coherence": 4.0, "f1": 0.3}
CICD_DIR = ROOT / "examples" / "foundry-cicd"
# The pipeline the lab runs itself: azd provision, then the gate (set up with infra/pipeline.sh).
CICD_FILES = [ROOT / ".github" / "workflows" / "infra.yml", ROOT / "infra" / "pipeline.sh"]


def f1(response: str, reference: str) -> float:
    """Token overlap between the response and the reference answer, the classic F1 used for extractive QA."""
    tok = lambda s: re.findall(r"[a-z0-9£]+", s.lower())
    a, b = tok(response), tok(reference)
    common = sum(min(a.count(w), b.count(w)) for w in set(a))
    if not common:
        return 0.0
    p, r = common / len(a), common / len(b)
    return round(2 * p * r / (p + r), 3)


class FoundryOpsService:
    def __init__(self, tools: FoundryTools | None, search: AzureSearch | None, spend: SpendTracker):
        self.tools, self.search, self.spend = tools, search, spend

    def _tools(self) -> FoundryTools:
        if self.tools is None or not self.tools.resource_id:
            raise ApiError(503, "not_configured", "Set AZURE_LANGUAGE_ENDPOINT and AZURE_AI_RESOURCE_ID (and the media ones) "
                                                  "in .env, run az login, and restart the backend.")
        return self.tools

    def _resources(self) -> list[str]:
        t = self._tools()
        return [r for r in (t.resource_id, t.media_resource_id) if r]

    def info(self) -> dict[str, Any]:
        examples = sorted(CICD_DIR.glob("*")) if CICD_DIR.exists() else []
        files = {p.name: p.read_text() for p in CICD_FILES + examples if p.is_file() and p.suffix in (".yml", ".sh", ".bicep", ".py")}
        return {"configured": self.tools is not None and bool(self.tools.resource_id), "deployment_types": DEPLOYMENT_TYPES,
                "gate": GATE, "eval_cases": len(EVAL_SET), "metrics": METRICS, "cicd": files}

    # ----- what is deployed, and how much is left -----
    def deployments(self) -> dict[str, Any]:
        t = self._tools()
        out = []
        for rid in self._resources():
            account = t.arm(rid, "2025-06-01")
            models = {(m["name"], m["version"]): m for m in t.arm(f"{rid}/models", "2025-06-01").get("value", [])}
            for d in t.arm(f"{rid}/deployments", "2025-06-01").get("value", []):
                m = d["properties"]["model"]
                life = models.get((m["name"], m["version"]), {})
                out.append({"resource": rid.rsplit("/", 1)[-1], "region": account["location"], "name": d["name"],
                            "model": m["name"], "version": m["version"], "sku": d["sku"]["name"], "capacity": d["sku"].get("capacity"),
                            "guardrail": d["properties"].get("raiPolicyName"), "upgrade": d["properties"].get("versionUpgradeOption"),
                            "lifecycle": life.get("lifecycleStatus"), "retires": (life.get("deprecation") or {}).get("inference")})
        return {"deployments": out}

    def quotas(self) -> dict[str, Any]:
        t = self._tools()
        sub = t.resource_id.split("/")[2]
        deployed = self.deployments()["deployments"]
        out = []
        for region in sorted({d["region"] for d in deployed}):
            usages = t.arm(f"/subscriptions/{sub}/providers/Microsoft.CognitiveServices/locations/{region}/usages", "2024-10-01")["value"]
            names = {f"OpenAI.{d['sku']}.{d['model']}" for d in deployed if d["region"] == region}
            for u in usages:
                if u["name"]["value"] in names:
                    mine = sum(d["capacity"] or 0 for d in deployed if d["region"] == region and f"OpenAI.{d['sku']}.{d['model']}" == u["name"]["value"])
                    out.append({"region": region, "quota": u["name"]["value"], "used": u["currentValue"], "limit": u["limit"],
                                "this_lab": mine, "unit": u.get("unit")})
        return {"quotas": out}

    def rate_limit(self) -> dict[str, Any]:
        """One tiny request, and the rate-limit headers that came back with it."""
        t = self._tools()
        started = time.perf_counter()
        r = t._send("Azure OpenAI", "POST", f"{t.endpoint}/openai/v1/chat/completions", timeout=60,
                    json={"model": JUDGE, "messages": [{"role": "user", "content": "Reply with the single word: ready"}],
                          "max_completion_tokens": 16})
        body = r.json()
        u = body.get("usage") or {}
        cost = self.spend.charge_usd((u.get("prompt_tokens", 0) * PRICES[JUDGE]["input"] + u.get("completion_tokens", 0) * PRICES[JUDGE]["output"]) / 1e6, JUDGE)
        headers = {k: v for k, v in r.headers.items() if k.startswith("x-ratelimit") or k in ("x-ms-region", "azureml-model-session")}
        return {"headers": headers, "ms": round((time.perf_counter() - started) * 1000), "usage": u, "cost_usd": round(cost, 6)}

    def metrics(self, hours: int = 24) -> dict[str, Any]:
        t = self._tools()
        end = datetime.now(timezone.utc).replace(microsecond=0)
        span = f"{(end - timedelta(hours=hours)).isoformat()}/{end.isoformat()}".replace("+00:00", "Z")
        out, notes = [], []
        for rid in self._resources():
            for name in METRICS:
                # Not every metric can be split by deployment (Ratelimit splits by region and key): fall back to unsplit.
                for split in ("ModelDeploymentName eq '*'", None):
                    try:
                        r = t.arm(f"{rid}/providers/Microsoft.Insights/metrics", "2023-10-01", metricnames=name, timespan=span,
                                  interval="PT1H", aggregation="Total,Average", **({"$filter": split} if split else {}))
                        break
                    except ApiError as exc:
                        if split is None:
                            notes.append(f"{name}: {exc.message[:120]}")
                            r = {"value": []}
                for m in r.get("value", []):
                    for series in m.get("timeseries", []):
                        dep = next((v["value"] for v in series.get("metadatavalues", [])
                                    if v["name"]["value"].lower() == "modeldeploymentname"), "all")
                        points = [{"t": p["timeStamp"][11:16], "total": p.get("total"), "average": p.get("average")} for p in series.get("data", [])]
                        agg = "average" if "Time" in m["name"]["value"] else "total"
                        values = [p[agg] for p in points if p[agg] is not None]
                        if values and any(values):
                            out.append({"resource": rid.rsplit("/", 1)[-1], "metric": m["name"]["value"], "unit": m.get("unit"),
                                        "deployment": dep, "aggregation": agg, "points": points,
                                        "sum": round(sum(values), 1), "max": round(max(values), 1)})
        return {"series": out, "hours": hours, "notes": notes}

    # ----- security -----
    def security(self) -> dict[str, Any]:
        t = self._tools()
        resources = []
        role_names: dict[str, str] = {}
        for rid in self._resources():
            a = t.arm(rid, "2025-06-01")
            p = a["properties"]
            roles = t.arm(f"{rid}/providers/Microsoft.Authorization/roleAssignments", "2022-04-01", **{"$filter": "atScope()"}).get("value", [])
            assigned = []
            for ra in roles:
                rd = ra["properties"]["roleDefinitionId"]
                if rd not in role_names:
                    role_names[rd] = t.arm(rd, "2022-04-01")["properties"]["roleName"]
                assigned.append({"role": role_names[rd], "principal_type": ra["properties"].get("principalType"),
                                 "scope": "this resource" if ra["properties"]["scope"].lower() == rid.lower() else "inherited"})
            checks = [
                ("Keyless: local (key) authentication disabled", bool(p.get("disableLocalAuth")), "Callers must use Microsoft Entra ID and a role."),
                ("Managed identity on the resource", bool(a.get("identity")), "Lets the resource reach storage, search and Key Vault without secrets."),
                ("Public network access disabled", p.get("publicNetworkAccess") == "Disabled", "Production: private endpoints and selected networks only."),
                ("Private endpoints", bool(p.get("privateEndpointConnections")), f"{len(p.get('privateEndpointConnections', []))} connections."),
                ("Custom subdomain (needed for Entra ID tokens)", bool(p.get("customSubDomainName")), p.get("customSubDomainName") or ""),
            ]
            resources.append({"name": a["name"], "region": a["location"], "kind": a["kind"],
                              "checks": [{"check": c, "ok": ok, "note": n} for c, ok, n in checks],
                              "roles": sorted(assigned, key=lambda x: x["role"])})
        return {"resources": resources}

    # ----- evaluation -----
    def evaluate(self) -> dict[str, Any]:
        t = self._tools()
        context = {k: f"{title}. {text}" for k, title, text in search_samples.POLICY}
        cost = 0.0

        def judge(case: tuple) -> dict:
            q, ctx_id, response, reference = case
            prompt = (f"Score the response to the question using only the context. Use the full 1 to 5 scale.\n\nContext: "
                      f"{context[ctx_id]}\n\nQuestion: {q}\n\nResponse: {response}")
            r = t.chat(JUDGE, [{"role": "user", "content": prompt}], max_completion_tokens=300,
                       response_format={"type": "json_schema", "json_schema": {"name": "scores", "schema": JUDGE_SCHEMA, "strict": True}})
            g = t.groundedness(response, [context[ctx_id]], q) if t.media_endpoint else {"ungroundedDetected": None}
            s = json.loads(r["choices"][0]["message"]["content"])
            return {"question": q, "response": response, "reference": reference, **s, "f1": f1(response, reference),
                    "content_safety_ungrounded": g["ungroundedDetected"], "usage": r.get("usage") or {}}

        started = time.perf_counter()
        with ThreadPoolExecutor(6) as pool:
            rows = list(pool.map(judge, EVAL_SET))
        for r in rows:
            u = r.pop("usage")
            cost += (u.get("prompt_tokens", 0) * PRICES[JUDGE]["input"] + u.get("completion_tokens", 0) * PRICES[JUDGE]["output"]) / 1e6
            cost += 2 * TOOL_PRICES["content_safety_text_per_1k"] / 1000
            r["passed"] = all(r[k] >= v for k, v in GATE.items())
        self.spend.charge_usd(cost, "Evaluation")
        means = {k: round(sum(r[k] for r in rows) / len(rows), 2) for k in GATE}
        return {"rows": rows, "means": means, "gate": GATE, "release": all(means[k] >= v for k, v in GATE.items()),
                "seconds": round(time.perf_counter() - started, 1), "cost_usd": round(cost, 6), "spent_usd": self.spend.spent_usd}

    # ----- tracing -----
    def trace(self, question: str) -> dict[str, Any]:
        """One retrieval-augmented answer, traced with OpenTelemetry spans and generative AI attributes."""
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor
        from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

        t = self._tools()
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        tracer = provider.get_tracer("llm-lab.foundry-ops")
        cost = 0.0
        with tracer.start_as_current_span("invoke_agent claims-assistant") as root:
            root.set_attribute("gen_ai.operation.name", "invoke_agent")
            root.set_attribute("gen_ai.agent.name", "claims-assistant")
            with tracer.start_as_current_span("embeddings text-embedding-3-small") as s:
                [vec], tokens = t.embed([question])
                s.set_attribute("gen_ai.request.model", "text-embedding-3-small")
                s.set_attribute("gen_ai.usage.input_tokens", tokens)
                cost += tokens * PRICES["text-embedding-3-small"]["input"] / 1e6
            passages = []
            with tracer.start_as_current_span("search lab-claims") as s:
                s.set_attribute("db.system", "azure_ai_search")
                if self.search is not None and self.search.index_exists("lab-claims"):
                    r = self.search.search("lab-claims", {"search": question, "top": 3, "select": "source,chunk",
                                                          "vectorQueries": [{"kind": "vector", "vector": vec, "fields": "contentVector", "k": 6}]})
                    passages = [f"[{h['source']}] {h['chunk']}" for h in r.get("value", [])]
                else:
                    passages = [f"[{k}] {title}. {text}" for k, title, text in search_samples.POLICY[:3]]
                    s.set_attribute("note", "index not built: policy sections used directly")
                s.set_attribute("search.results", len(passages))
            with tracer.start_as_current_span(f"chat {JUDGE}") as s:
                r = t.chat(JUDGE, [{"role": "system", "content": "Answer in two sentences from the passages, citing [source]."},
                                   {"role": "user", "content": "Passages:\n" + "\n".join(passages) + f"\n\nQuestion: {question}"}],
                           max_completion_tokens=300)
                u = r.get("usage") or {}
                answer = r["choices"][0]["message"]["content"]
                s.set_attribute("gen_ai.system", "az.ai.openai")
                s.set_attribute("gen_ai.request.model", JUDGE)
                s.set_attribute("gen_ai.usage.input_tokens", u.get("prompt_tokens", 0))
                s.set_attribute("gen_ai.usage.output_tokens", u.get("completion_tokens", 0))
                s.set_attribute("gen_ai.response.finish_reasons", [r["choices"][0].get("finish_reason", "")])
                cost += (u.get("prompt_tokens", 0) * PRICES[JUDGE]["input"] + u.get("completion_tokens", 0) * PRICES[JUDGE]["output"]) / 1e6
            with tracer.start_as_current_span("content_safety text:analyze") as s:
                mod = t.analyze_text(answer)
                worst = max(c["severity"] for c in mod["categoriesAnalysis"])
                s.set_attribute("safety.max_severity", worst)
                cost += TOOL_PRICES["content_safety_text_per_1k"] / 1000
        self.spend.charge_usd(cost, "Traced run")
        spans = exporter.get_finished_spans()
        t0 = min(sp.start_time for sp in spans)
        out = [{"name": sp.name, "parent": sp.parent.span_id if sp.parent else None, "id": sp.context.span_id,
                "start_ms": round((sp.start_time - t0) / 1e6), "ms": round((sp.end_time - sp.start_time) / 1e6),
                "attributes": {k: (list(v) if isinstance(v, tuple) else v) for k, v in (sp.attributes or {}).items()}}
               for sp in sorted(spans, key=lambda x: x.start_time)]
        return {"spans": out, "answer": answer, "trace_id": format(spans[0].context.trace_id, "032x"),
                "cost_usd": round(cost, 6), "spent_usd": self.spend.spent_usd}
