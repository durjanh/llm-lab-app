"""W&B Weave: weave.op tracing of the RAG app and a weave.Evaluation with scorers over the six questions.

Needs WANDB_API_KEY. Without it the script still imports Weave and defines the ops and the evaluation.
"""
from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
from common import checks, config  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # observability
import shared  # noqa: E402

NAME = "observability/weave"


def build():
    import anthropic
    import weave

    client = anthropic.Anthropic()  # weave patches the Anthropic SDK itself, so each call is a traced child op

    @weave.op()
    def retrieve(question: str) -> list[str]:
        return shared.retrieve(question)

    class RagModel(weave.Model):
        model_name: str = shared.MODEL

        @weave.op()
        def predict(self, question: str) -> dict:
            contexts = retrieve(question)
            return {"answer": shared.text_of(shared.generate(client, question, contexts)), "contexts": contexts}

    @weave.op()
    def gold_match(pattern: str, output: dict) -> dict:
        return {"correct": bool(re.search(pattern, output["answer"], re.I))}

    @weave.op()
    def grounded_in_context(output: dict) -> dict:
        # a cheap groundedness proxy: the answer's digits all appear in the retrieved context
        digits = re.findall(r"\d+", output["answer"])
        return {"grounded": all(d in " ".join(output["contexts"]) for d in digits)}

    dataset = [{"question": g.question, "pattern": g.answer} for g in shared.QUESTIONS]
    return RagModel(), weave.Evaluation(dataset=dataset, scorers=[gold_match, grounded_in_context])


def main() -> None:
    if not config.HAS_CLAUDE:
        return checks.skip(NAME, "set ANTHROPIC_API_KEY")
    key = config.env("WANDB_API_KEY")
    if not key:
        build()
        return checks.skip(NAME, "set WANDB_API_KEY to trace and evaluate on W&B Weave (ops and evaluation build fine)")
    import weave
    weave.init(config.env("WEAVE_PROJECT") or "stack-observability")
    model, evaluation = build()
    summary = asyncio.run(evaluation.evaluate(model))
    correct = summary["gold_match"]["correct"]["true_count"]
    n = len(shared.QUESTIONS)
    checks.report(NAME, correct >= 5, f"{n} questions scored, {correct}/{n} correct; summary {summary}")


if __name__ == "__main__":
    main()
