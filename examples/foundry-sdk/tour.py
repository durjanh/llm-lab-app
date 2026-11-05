"""A tour of the Microsoft Foundry SDK (azure-ai-projects): the parts of a project the lab's other examples do not use.

    python examples/foundry-sdk/tour.py project    # connections and deployments: what the project can reach
    python examples/foundry-sdk/tour.py respond    # a model called through the project, the service keeping the thread
    python examples/foundry-sdk/tour.py data       # datasets (upload, version, delete) and indexes
    python examples/foundry-sdk/tour.py evaluate   # a cloud evaluation with built-in evaluators; one answer is made up
    python examples/foundry-sdk/tour.py trace      # OpenTelemetry spans for model calls, and where they can go
    python examples/foundry-sdk/tour.py all

MedAssist (examples/medassist) covers agents, tools, vector stores and conversations; this covers the rest of the
project client. Reads FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_MODEL from the lab's .env and signs in with az login: the
client takes Entra ID only, never a key. Everything the tour creates it deletes again, except the latest
evaluation, kept so its portal report opens. A full run costs about a penny.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

from azure.ai.projects import AIProjectClient
from azure.ai.projects.models import ConnectionType, TestingCriterionAzureAIEvaluator
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parents[1] / ".env")
MODEL = os.environ.get("FOUNDRY_MODEL", "")

# Home insurance questions with the policy text that answers them. The last answer contradicts its context: the
# groundedness evaluator should catch it, and relevance should not (it does answer the question).
CASES = [
    {"query": "What is the excess for escape of water claims?", "context": "The excess for escape of water claims is £350.",
     "response": "The excess for escape of water is £350.", "ground_truth": "£350"},
    {"query": "How soon must I report a claim?", "context": "Tell us about a claim within 30 days of the damage.",
     "response": "You need to report it within 30 days of the damage.", "ground_truth": "Within 30 days of the damage"},
    {"query": "How long can I stay in a hotel if my home is unliveable?",
     "context": "We pay for alternative accommodation up to £20,000 or 12 months, whichever comes first.",
     "response": "Up to 12 months, or until the cost reaches £20,000, whichever comes first.",
     "ground_truth": "Up to £20,000 or 12 months"},
    {"query": "Is a slow drip covered?", "context": "We do not cover water that escapes gradually over time.",
     "response": "Yes, all water damage is covered, including slow drips over several months.",
     "ground_truth": "No, gradual escapes are not covered"},
]

# What each kind of connection would let the project do. Connections are made in the portal or Bicep, not here.
CONNECTION_USES = {
    ConnectionType.AZURE_AI_SEARCH: "register your own search index (indexes) and give agents the Azure AI Search tool",
    ConnectionType.APPLICATION_INSIGHTS: "send traces to Application Insights, where the portal's Tracing page shows them",
    ConnectionType.AZURE_STORAGE_ACCOUNT: "keep datasets in your own storage account instead of the project's",
    ConnectionType.AZURE_OPEN_AI: "use models deployed in another Azure OpenAI resource",
}


def heading(text: str) -> None:
    print(f"\n== {text} ==")


# ----- 1. The project: what it can reach -----

def project(p: AIProjectClient) -> None:
    """Connections and deployments, read through the project rather than through Resource Manager."""
    heading("Connections: other resources the project can use")
    connections = list(p.connections.list())
    for c in connections:  # never include_credentials=True: the lab signs in with Entra, so there are none to read
        print(f"  {c.name:30} {c.type:22} default={c.is_default}  {c.target}")
    if not connections:
        print("  none. A connection names another resource and how to sign in to it. With one you could:")
    present = {c.type for c in connections}
    for kind, use in CONNECTION_USES.items():
        if kind not in present:
            print(f"  - {kind.value}: {use}")

    heading("Deployments: the models this project can call, by deployment name")
    for d in p.deployments.list():
        sku = f"{d.sku.name} x{d.sku.capacity}" if d.sku else ""
        caps = ", ".join(k for k, v in (d.capabilities or {}).items() if v == "true")
        print(f"  {d.name:24} {d.model_publisher or '':10} {d.model_name} {d.model_version}  {sku:20} {caps}")
    print("  The deployment name, not the model name, is what calls use: rename or upgrade without changing code.")


# ----- 2. A model through the project -----

def respond(p: AIProjectClient) -> None:
    """The Responses API through get_openai_client(): the same signed-in client agents use."""
    heading(f"Responses: {MODEL}, with the service keeping the thread")
    with p.get_openai_client() as client:
        first = client.responses.create(model=MODEL, max_output_tokens=200,
                                        input="Name three things a UK home insurance policy usually excludes. One line.")
        print(f"  you: three usual exclusions?\n  {MODEL}: {first.output_text.strip()}")
        # previous_response_id: the service keeps the earlier turn, so the app does not send it again
        second = client.responses.create(model=MODEL, max_output_tokens=200, previous_response_id=first.id,
                                         input="Which of those leads to the most disputes? One sentence.")
        print(f"  you: which is most disputed?\n  {MODEL}: {second.output_text.strip()}")
        print(f"  tokens: first {first.usage.input_tokens} in, {first.usage.output_tokens} out; "
              f"second {second.usage.input_tokens} in (the first turn is counted again, though not sent again)")
        client.responses.delete(first.id)
        client.responses.delete(second.id)


# ----- 3. Data: datasets and indexes -----

def data(p: AIProjectClient) -> None:
    """Datasets are versioned files the project keeps (for evaluation or fine-tuning); indexes point at search indexes."""
    name = "lab-tour-cases"
    heading("Datasets: versioned data in the project")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cases.jsonl"
        path.write_text("\n".join(json.dumps(c) for c in CASES[:3]) + "\n")
        v1 = p.datasets.upload_file(name=name, version="1", file_path=str(path))
        print(f"  uploaded {name} v1: {v1.id}")
        print(f"    stored at {v1.data_uri.split('?')[0][:80]}... (the project's own storage: no storage connection)")
        path.write_text("\n".join(json.dumps(c) for c in CASES) + "\n")
        p.datasets.upload_file(name=name, version="2", file_path=str(path))
        print(f"  uploaded {name} v2, with the made-up answer added")
    # get() is immediate; list_versions() catches up a little later, so a fresh upload can be missing from it
    for version in ("1", "2"):
        d = p.datasets.get(name=name, version=version)
        print(f"  get {name} v{d.version}: {d.type}, created {str(d.get('systemData', {}).get('createdAt', ''))[:19]}")
    for version in ("1", "2"):
        p.datasets.delete(name=name, version=version)
    print(f"  deleted both versions of {name}")
    others = [d for d in p.datasets.list() if d.name != name]
    if others:
        print(f"  also in the project: {len(others)} files agents uploaded for File Search, e.g. {others[0].description}")

    heading("Indexes: search indexes the project knows about")
    for i in p.indexes.list():
        detail = f"vector store {i.get('vectorStoreId')}" if i.get("type") == "ManagedAzureSearch" else i.get("indexName", "")
        print(f"  {i.name} v{i.version}  {i.type}  {detail}")
    print("  ManagedAzureSearch: a File Search vector store an agent made (MedAssist's knowledge is one).")
    print("  Your own Azure AI Search index needs a CognitiveSearch connection, then:")
    print("    p.indexes.create_or_update(name=..., version='1',")
    print("        index=AzureAISearchIndex(connection_name='<connection>', index_name='<index in AI Search>'))")


# ----- 4. A cloud evaluation -----

def evaluate(p: AIProjectClient) -> None:
    """Built-in evaluators, run by the service over inline data. Results also appear in the portal's Evaluations."""
    heading("Evaluation: four answers, five built-in evaluators, run in Foundry")
    judge = {"deployment_name": MODEL}  # AI-assisted evaluators use one of your deployments as the judge
    criteria = [
        TestingCriterionAzureAIEvaluator(type="azure_ai_evaluator", name="groundedness", evaluator_name="builtin.groundedness",
                                         initialization_parameters=judge,
                                         data_mapping={"query": "{{item.query}}", "context": "{{item.context}}",
                                                       "response": "{{item.response}}"}),
        TestingCriterionAzureAIEvaluator(type="azure_ai_evaluator", name="relevance", evaluator_name="builtin.relevance",
                                         initialization_parameters=judge,
                                         data_mapping={"query": "{{item.query}}", "response": "{{item.response}}"}),
        TestingCriterionAzureAIEvaluator(type="azure_ai_evaluator", name="coherence", evaluator_name="builtin.coherence",
                                         initialization_parameters=judge,
                                         data_mapping={"query": "{{item.query}}", "response": "{{item.response}}"}),
        # F1 is plain arithmetic (word overlap with the reference answer); no model involved
        TestingCriterionAzureAIEvaluator(type="azure_ai_evaluator", name="f1", evaluator_name="builtin.f1_score",
                                         data_mapping={"response": "{{item.response}}", "ground_truth": "{{item.ground_truth}}"}),
        # A safety evaluator: Foundry's own safety model, so it takes no deployment
        TestingCriterionAzureAIEvaluator(type="azure_ai_evaluator", name="violence", evaluator_name="builtin.violence",
                                         data_mapping={"query": "{{item.query}}", "response": "{{item.response}}"}),
    ]
    schema = {"type": "object", "required": [],
              "properties": {k: {"type": "string"} for k in ("query", "context", "response", "ground_truth")}}
    with p.get_openai_client() as client:
        for old in client.evals.list():  # the last run's evaluation stays for its portal report; replace it now
            if old.name == "lab-tour":
                client.evals.delete(eval_id=old.id)
        ev = client.evals.create(name="lab-tour", data_source_config={"type": "custom", "item_schema": schema,
                                                                      "include_sample_schema": True},
                                 testing_criteria=criteria)
        run = client.evals.runs.create(eval_id=ev.id, name="insurance answers",
                                       data_source={"type": "jsonl", "source": {"type": "file_content",
                                                    "content": [{"item": c} for c in CASES]}})
        print(f"  run {run.id} started", end="", flush=True)
        while run.status not in ("completed", "failed", "canceled"):
            time.sleep(5)
            print(".", end="", flush=True)
            run = client.evals.runs.retrieve(run_id=run.id, eval_id=ev.id)
        print(f" {run.status}")
        if run.status != "completed":
            print(f"  error: {getattr(run, 'error', None)}")
            return
        names = [c["name"] for c in criteria]
        print(f"\n  {'question':46}" + "".join(f"{n:>14}" for n in names))
        items = sorted(client.evals.runs.output_items.list(run_id=run.id, eval_id=ev.id),
                       key=lambda i: [c["query"] for c in CASES].index(i.datasource_item["query"]))
        errors: dict[str, str] = {}
        for item in items:
            cells = []
            for n in names:
                r = next((r for r in item.results if r.name == n), None)
                if r is None or r.status == "error" or r.score is None:
                    if r is not None and isinstance(r.sample, dict) and "error" in r.sample:
                        errors[n] = r.sample["error"].get("message", "").split("\n")[0]
                    cells.append(f"{'error':>14}")
                else:
                    verdict = "" if r.passed is None else (" ok" if r.passed else " FAIL")
                    cells.append(f"{round(r.score, 2):g}{verdict}".rjust(14))
            print(f"  {item.datasource_item['query'][:44]:46}" + "".join(cells))
        print("\n  " + ", ".join(f"{c.testing_criteria} {c.passed} passed, {c.failed} failed"
                                + (f", {c.errored} errors" if c.errored else "") for c in run.per_testing_criteria_results))
        grounded = next((r for r in items[-1].results if r.name == "groundedness"), None)
        if grounded is not None and grounded.reason:
            print(f"\n  why the last answer is not grounded: {grounded.reason}")
        print("\n  relevance passes it, rightly: it does answer the question. Only groundedness checks it against the policy.")
        print("  F1 is word overlap with the reference answer: a correct answer in more words scores low, so it is a weak gate.")
        for n, message in errors.items():
            print(f"  {n}: {message}")
        if "violence" in errors:
            print("  The safety (content harm) evaluators run only in some regions; this project's is not one.")
        print(f"\n  report in the portal: {run.report_url}")
        print("  The evaluation stays so the report opens; the next run of this section replaces it.")


# ----- 5. Tracing -----

def trace_calls(p: AIProjectClient) -> None:
    """OpenTelemetry spans for model calls. Application Insights when the project has one; collected here otherwise."""
    os.environ.setdefault("AZURE_EXPERIMENTAL_ENABLE_GENAI_TRACING", "true")  # GenAI tracing is off unless asked for
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from azure.ai.projects.telemetry import AIProjectInstrumentor
    from azure.core.settings import settings

    settings.tracing_implementation = "opentelemetry"  # the SDK makes its spans through azure-core's tracing

    heading("Tracing: OpenTelemetry spans for each call")
    try:
        p.telemetry.get_application_insights_connection_string()
        print("  The project has Application Insights: with azure-monitor-opentelemetry installed,")
        print("  configure_azure_monitor(connection_string=...) sends these spans to it, and the portal shows them.")
    except Exception:
        print("  No Application Insights connected, so the spans are collected here and printed.")
        print("  Connected, p.telemetry.get_application_insights_connection_string() gives configure_azure_monitor()")
        print("  what it needs, and the portal's Tracing page shows the same spans.")
    spans = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(spans))
    trace.set_tracer_provider(provider)
    # Content recording off: prompts and answers can hold personal data, so spans carry sizes and ids, not text
    AIProjectInstrumentor().instrument(enable_content_recording=False)
    tracer = trace.get_tracer("lab.tour")
    try:
        with tracer.start_as_current_span("answer a policy question"), p.get_openai_client() as client:
            first = client.responses.create(model=MODEL, max_output_tokens=100, input="Is subsidence usually covered? One line.")
            second = client.responses.create(model=MODEL, max_output_tokens=100, previous_response_id=first.id,
                                             input="And what usually is not? One line.")
            for r in (first, second):
                client.responses.delete(r.id)
    finally:
        AIProjectInstrumentor().uninstrument()
    finished = sorted(spans.get_finished_spans(), key=lambda s: s.start_time)
    by_id = {s.context.span_id: s for s in finished}
    for s in finished:
        depth = 0
        parent = s.parent
        while parent is not None and parent.span_id in by_id:
            depth += 1
            parent = by_id[parent.span_id].parent
        a = s.attributes or {}
        keep = {k.removeprefix("gen_ai."): v for k, v in a.items()
                if k in ("gen_ai.request.model", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens")}
        ms = (s.end_time - s.start_time) / 1e6
        print(f"  {'  ' * depth}{s.name:40} {ms:7.0f} ms  {keep if keep else ''}")
    print(f"  {len(finished)} spans: one per call under the app's own span, so a slow or costly step stands out.")


SECTIONS = {"project": project, "respond": respond, "data": data, "evaluate": evaluate, "trace": trace_calls}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("section", choices=[*SECTIONS, "all"])
    args = ap.parse_args()
    endpoint = os.environ.get("FOUNDRY_PROJECT_ENDPOINT")
    if not endpoint or not MODEL:
        sys.exit("Set FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_MODEL in the lab's .env, and run az login.")
    with DefaultAzureCredential() as credential, AIProjectClient(endpoint=endpoint, credential=credential) as p:
        print(f"Project: {endpoint}")
        for name, run in SECTIONS.items():
            if args.section in (name, "all"):
                run(p)


if __name__ == "__main__":
    main()
