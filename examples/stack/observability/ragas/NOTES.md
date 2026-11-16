# Ragas

**What it is.** A library of reference-based and reference-free metrics for RAG: faithfulness (claims in the answer supported by the context), factual and answer correctness (against a reference answer), context precision and context recall (did retrieval rank and cover what the reference needs).

**How it does this task.** `run.py` runs the app on the six questions. The reference for each is the handbook sentence that holds the gold fact. Claude is the evaluator through `LangchainLLMWrapper(ChatAnthropic(...))`. Embeddings are local BGE small through `langchain-huggingface`. It scores `Faithfulness`, `FactualCorrectness`, `AnswerCorrectness`, `LLMContextPrecisionWithReference` and `LLMContextRecall`, prints the per-answer table and the means. An answer is judged correct when its answer correctness (a blend of factual and semantic similarity) is 0.5 or more.

**Limits.** Each metric is several LLM calls (claim extraction, then verification), so it is the most expensive tool here per question. It installs PyTorch through sentence-transformers. Factual correctness compares claims with the whole reference sentence, so a right but terse answer ("£35") scored 0.00 and a right full sentence 0.67; that is why the pass rule uses answer correctness. Faithfulness scored one right answer 0.0 for adding "first day" that the context did not state.

**Seen.** `claude-haiku-5-5` rejects the `temperature` parameter with a 400, and Ragas always sends one, so every metric came back NaN on the first run. `LangchainLLMWrapper(..., bypass_temperature=True)` stops it. Ragas 0.4 still exports the older metric classes but marks them as legacy; the newer ones live under `ragas.metrics.collections`. The older classes were used because they accept the LangChain wrappers directly.

Ran on 2026-11-15: PASS. 6/6 answers scored, 6/6 judged correct (6/6 match gold); means faithfulness 1.00, factual_correctness(mode=f1) 0.67, answer_correctness 0.75, llm_context_precision_with_reference 1.00, context_recall 1.00
