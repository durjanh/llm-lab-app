"""Arize Phoenix, local: OpenInference spans for the Anthropic SDK, read back through the client, then a judged eval."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
from common import checks, config  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # observability
import shared  # noqa: E402

NAME = "observability/phoenix"
PORT, GRPC = 18510, 18511
HOST = f"http://127.0.0.1:{PORT}"
PROJECT = "stack-observability"


def start_server(workdir: str) -> subprocess.Popen:
    """The Phoenix server as a child process, with its data in a temporary folder and telemetry off."""
    env = {**os.environ, "PHOENIX_PORT": str(PORT), "PHOENIX_GRPC_PORT": str(GRPC), "PHOENIX_HOST": "127.0.0.1",
           "PHOENIX_WORKING_DIR": workdir, "PHOENIX_TELEMETRY_ENABLED": "false"}
    proc = subprocess.Popen([sys.executable, "-m", "phoenix.server.main", "serve"], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import urllib.request
    for _ in range(90):
        try:
            urllib.request.urlopen(HOST + "/healthz", timeout=2)
            return proc
        except Exception:
            time.sleep(1)
    proc.terminate()
    raise RuntimeError("Phoenix server did not start")


def main() -> None:
    if not config.HAS_CLAUDE:
        return checks.skip(NAME, "set ANTHROPIC_API_KEY")
    import anthropic
    import pandas as pd
    from openinference.instrumentation.anthropic import AnthropicInstrumentor
    from opentelemetry import trace
    from phoenix.client import Client
    from phoenix.evals import LLM, evaluate_dataframe
    from phoenix.evals.metrics import CorrectnessEvaluator
    from phoenix.otel import register

    with tempfile.TemporaryDirectory() as workdir:
        proc = start_server(workdir)
        try:
            provider = register(project_name=PROJECT, endpoint=f"{HOST}/v1/traces", batch=False, set_global_tracer_provider=False)
            AnthropicInstrumentor().instrument(tracer_provider=provider)
            tracer = provider.get_tracer("stack")
            client = anthropic.Anthropic()
            rows = []
            for g in shared.QUESTIONS:
                with tracer.start_as_current_span("rag-question") as root:
                    root.set_attribute("input.value", g.question)
                    with tracer.start_as_current_span("retrieval") as span:
                        contexts = shared.retrieve(g.question)
                        span.set_attribute("openinference.span.kind", "RETRIEVER")
                        span.set_attribute("input.value", g.question)
                        span.set_attribute("output.value", "\n".join(contexts))
                    msg = shared.generate(client, g.question, contexts)  # an LLM span, from the instrumentor
                    text = shared.text_of(msg)
                    root.set_attribute("output.value", text)
                rows.append({"question": g.question, "contexts": contexts, "answer": text})
            provider.force_flush()

            # Read the spans back: one LLM span and one retriever span per question.
            px = Client(base_url=HOST)
            df = None
            for _ in range(30):
                df = px.spans.get_spans_dataframe(project_name=PROJECT)
                kinds = df["attributes.openinference.span.kind"].tolist() if len(df) else []
                if kinds.count("LLM") >= len(rows) and kinds.count("RETRIEVER") >= len(rows):
                    break
                time.sleep(2)
            kinds = df["attributes.openinference.span.kind"].tolist()
            llm_spans, ret_spans = kinds.count("LLM"), kinds.count("RETRIEVER")
            tokens = int(df.get("attributes.llm.token_count.total", pd.Series([0])).fillna(0).sum())

            # Phoenix evaluation: Claude judges whether each answer is correct for its context.
            llm = LLM(provider="anthropic", model=shared.MODEL)
            frame = pd.DataFrame({
                "input": [f"Context:\n" + "\n".join(r["contexts"]) + f"\n\nQuestion: {r['question']}" for r in rows],
                "output": [r["answer"] for r in rows]})
            result = evaluate_dataframe(frame, [CorrectnessEvaluator(llm=llm)])
            col = [c for c in result.columns if c.endswith("_score")][0]
            judged = [int(((v or {}) if isinstance(v, dict) else {}).get("score", 0) or 0) for v in result[col]]
            print("judge labels:", [(v or {}).get("label") for v in result[col]])
            print("gold-pattern matches:", [g.correct(r["answer"]) for g, r in zip(shared.QUESTIONS, rows)])
            n = len(rows)
            ok = llm_spans >= n and ret_spans >= n and sum(judged) >= 5 and len(judged) == n
            checks.report(NAME, ok, f"{llm_spans}/{n} LLM spans and {ret_spans}/{n} retriever spans read back "
                                    f"({tokens} tokens); Phoenix correctness eval judged {sum(judged)}/{n} correct")
        finally:
            proc.terminate()
            proc.wait(timeout=20)


if __name__ == "__main__":
    main()
