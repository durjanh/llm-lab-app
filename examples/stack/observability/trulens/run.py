"""TruLens (local SQLite): the RAG triad on the six answers, with Claude as the feedback provider through LiteLLM."""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

os.environ["TRULENS_OTEL_TRACING"] = "1"  # TruLens 2.x records through OpenTelemetry spans
os.environ.setdefault("LITELLM_LOG", "ERROR")
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")  # no network fetch of the price map

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
from common import checks, config  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # observability
import shared  # noqa: E402

NAME = "observability/trulens"


def main() -> None:
    if not config.HAS_CLAUDE:
        return checks.skip(NAME, "set ANTHROPIC_API_KEY")
    import anthropic
    import numpy as np
    from trulens.apps.app import TruApp
    from trulens.core import Feedback, TruSession
    from trulens.core.feedback.selector import Selector
    from trulens.core.otel.instrument import instrument
    from trulens.otel.semconv.trace import SpanAttributes
    from trulens.providers.litellm import LiteLLM

    client = anthropic.Anthropic()

    class RAG:
        @instrument(span_type=SpanAttributes.SpanType.RETRIEVAL, attributes={
            SpanAttributes.RETRIEVAL.QUERY_TEXT: "query", SpanAttributes.RETRIEVAL.RETRIEVED_CONTEXTS: "return"})
        def retrieve(self, query: str) -> list:
            return shared.retrieve(query)

        @instrument(span_type=SpanAttributes.SpanType.GENERATION)
        def generate(self, query: str, contexts: list) -> str:
            return shared.text_of(shared.generate(client, query, contexts))

        @instrument(span_type=SpanAttributes.SpanType.RECORD_ROOT, attributes={
            SpanAttributes.RECORD_ROOT.INPUT: "query", SpanAttributes.RECORD_ROOT.OUTPUT: "return"})
        def query(self, query: str) -> str:
            return self.generate(query, self.retrieve(query))

    with tempfile.TemporaryDirectory() as tmp:
        session = TruSession(database_url=f"sqlite:///{tmp}/trulens.db")
        session.reset_database()
        provider = LiteLLM(model_engine=f"anthropic/{shared.MODEL}")
        q_in = Selector(span_type=SpanAttributes.SpanType.RETRIEVAL, span_attribute=SpanAttributes.RETRIEVAL.QUERY_TEXT)
        ctx_each = Selector(span_type=SpanAttributes.SpanType.RETRIEVAL, span_attribute=SpanAttributes.RETRIEVAL.RETRIEVED_CONTEXTS,
                            collect_list=False)
        ctx_all = Selector(span_type=SpanAttributes.SpanType.RETRIEVAL, span_attribute=SpanAttributes.RETRIEVAL.RETRIEVED_CONTEXTS,
                           collect_list=True)
        out = Selector(span_type=SpanAttributes.SpanType.RECORD_ROOT, span_attribute=SpanAttributes.RECORD_ROOT.OUTPUT)
        root_in = Selector(span_type=SpanAttributes.SpanType.RECORD_ROOT, span_attribute=SpanAttributes.RECORD_ROOT.INPUT)
        feedbacks = [
            Feedback(provider.context_relevance_with_cot_reasons, name="Context Relevance")
            .on({"question": q_in}).on({"context": ctx_each}).aggregate(np.mean),
            Feedback(provider.groundedness_measure_with_cot_reasons, name="Groundedness")
            .on({"source": ctx_all}).on({"statement": out}),
            Feedback(provider.relevance_with_cot_reasons, name="Answer Relevance")
            .on({"prompt": root_in}).on({"response": out}),
        ]
        app = TruApp(RAG(), app_name="northwind-rag", app_version="keyword-top2", feedbacks=feedbacks)
        answers = []
        with app:
            for g in shared.QUESTIONS:
                answers.append(app.app.query(g.question))
        session.force_flush()
        cols = ["Context Relevance", "Groundedness", "Answer Relevance"]
        for _ in range(60):  # feedbacks run in a background evaluator; wait until all six records have all three
            records, names = session.get_records_and_feedback(app_name="northwind-rag", app_versions=["keyword-top2"])
            if len(records) >= len(answers) and all(c in records for c in cols) and records[cols].notna().all().all():
                break
            time.sleep(3)
        board = session.get_leaderboard()
        scored = int(records[cols].notna().all(axis=1).sum()) if all(c in records for c in cols) else 0
        print(board.to_string())
        n = len(answers)
        correct = sum(g.correct(a) for g, a in zip(shared.QUESTIONS, answers))
        scores = {c: float(records[c].mean()) for c in cols if c in records and records[c].notna().all()}
        ok = scored == n and len(scores) == 3 and correct >= 5
        checks.report(NAME, ok, f"{scored}/{n} records scored; " + ", ".join(f"{k} {v:.2f}" for k, v in scores.items())
                      + f"; {correct}/{n} answers match gold")


if __name__ == "__main__":
    main()
