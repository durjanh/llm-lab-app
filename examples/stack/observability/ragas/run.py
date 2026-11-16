"""Ragas: faithfulness, factual correctness, answer correctness, context precision and recall on the six answers.

Claude (through LangChain) is the evaluator LLM. Embeddings are local BGE small. The reference for each question is the
handbook sentence that holds the gold fact.
"""
from __future__ import annotations

import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
from common import checks, config, data  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # observability
import shared  # noqa: E402

NAME = "observability/ragas"


def reference_for(gold) -> str:
    """The handbook sentence (without its section prefix) that contains the gold fact."""
    for c in data.chunks():
        if c.section == gold.section and gold.correct(c.text):
            return c.text.split(": ", 1)[1]
    return gold.section


def main() -> None:
    if not config.HAS_CLAUDE:
        return checks.skip(NAME, "set ANTHROPIC_API_KEY")
    warnings.filterwarnings("ignore")
    import anthropic
    from langchain_anthropic import ChatAnthropic
    from langchain_huggingface import HuggingFaceEmbeddings
    from ragas import EvaluationDataset, evaluate
    from ragas.embeddings import LangchainEmbeddingsWrapper
    from ragas.llms import LangchainLLMWrapper
    from ragas.metrics import AnswerCorrectness, FactualCorrectness, Faithfulness, LLMContextPrecisionWithReference, LLMContextRecall

    rows = shared.answer_all(anthropic.Anthropic())
    samples = [{"user_input": r["question"], "retrieved_contexts": r["contexts"], "response": r["answer"],
                "reference": reference_for(g)} for r, g in zip(rows, shared.QUESTIONS)]
    # claude-haiku-5-5 rejects `temperature`, which Ragas sends by default, so bypass it.
    llm = LangchainLLMWrapper(ChatAnthropic(model=shared.MODEL, max_tokens=1500), bypass_temperature=True)
    emb = LangchainEmbeddingsWrapper(HuggingFaceEmbeddings(model_name=config.LOCAL_EMBEDDING))
    result = evaluate(EvaluationDataset.from_list(samples),
                      metrics=[Faithfulness(), FactualCorrectness(), AnswerCorrectness(), LLMContextPrecisionWithReference(),
                               LLMContextRecall()],
                      llm=llm, embeddings=emb, show_progress=False)
    df = result.to_pandas()
    metric_cols = [c for c in df.columns if c not in samples[0]]
    print(df[metric_cols].round(2).to_string())
    means = {c: float(df[c].mean()) for c in metric_cols}
    n = len(rows)
    complete = int(df[metric_cols].notna().all(axis=1).sum())
    # An answer counts as judged correct when its answer correctness (facts plus meaning) is at least 0.5. Factual
    # correctness alone is too harsh on one-sentence answers compared with a whole reference sentence.
    fc = "answer_correctness"
    correct = int((df[fc] >= 0.5).sum())
    gold = sum(r["correct"] for r in rows)
    checks.report(NAME, complete == n and correct >= 5,
                  f"{complete}/{n} answers scored, {correct}/{n} judged correct ({gold}/{n} match gold); means "
                  + ", ".join(f"{c} {v:.2f}" for c, v in means.items()))


if __name__ == "__main__":
    main()
