"""LangSmith: @traceable spans for the RAG app and an evaluation run with a gold-match evaluator.

Needs LANGSMITH_API_KEY. Without it the script still imports the SDK and builds the traced functions.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
from common import checks, config  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # observability
import shared  # noqa: E402

NAME = "observability/langsmith"
PROJECT = "stack-observability"


def build_app():
    import anthropic
    from langsmith import traceable
    from langsmith.wrappers import wrap_anthropic

    client = wrap_anthropic(anthropic.Anthropic())  # the LLM call becomes a child run with token usage

    @traceable(run_type="retriever", name="retrieval")
    def retrieve(question: str) -> list[str]:
        return shared.retrieve(question)

    @traceable(name="rag-question")
    def rag(question: str) -> str:
        return shared.text_of(shared.generate(client, question, retrieve(question)))

    return rag


def main() -> None:
    if not config.HAS_CLAUDE:
        return checks.skip(NAME, "set ANTHROPIC_API_KEY")
    rag = build_app()
    if not config.env("LANGSMITH_API_KEY"):
        return checks.skip(NAME, "set LANGSMITH_API_KEY to trace and evaluate on LangSmith (the traced app builds fine)")
    from langsmith import Client, evaluate
    client = Client()
    name = f"northwind-{int(time.time())}"
    dataset = client.create_dataset(name)
    client.create_examples(dataset_id=dataset.id, examples=[
        {"inputs": {"question": g.question}, "outputs": {"pattern": g.answer}} for g in shared.QUESTIONS])

    def gold_match(outputs: dict, reference_outputs: dict) -> dict:
        import re
        return {"key": "gold_match", "score": int(bool(re.search(reference_outputs["pattern"], outputs["answer"], re.I)))}

    results = evaluate(lambda inputs: {"answer": rag(inputs["question"])}, data=name, evaluators=[gold_match],
                       experiment_prefix="stack-observability", client=client)
    scores = [r["evaluation_results"]["results"][0].score for r in results]
    checks.report(NAME, len(scores) == len(shared.QUESTIONS) and sum(scores) >= 5,
                  f"{len(scores)} runs scored, {sum(scores)}/{len(scores)} correct")
    client.delete_dataset(dataset_id=dataset.id)


if __name__ == "__main__":
    main()
