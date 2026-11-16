# LangSmith

**What it is.** LangChain's hosted tracing, datasets and evaluation product. It works without LangChain: `@traceable` records a function as a run, `wrap_anthropic` records the SDK call with tokens, and `evaluate` runs a function over a dataset with evaluators. The lab's own notes only mention it in the SDK pages; this makes it runnable.

**How it does this task.** `run.py` traces the retrieval step (`run_type="retriever"`) and the question, wraps the Anthropic client, creates a six-example dataset (question, gold pattern), runs `evaluate` with a `gold_match` evaluator, counts the scores, and deletes the dataset.

**Not run.** `LANGSMITH_API_KEY` is not set here, so this printed SKIP. The traced app is built before the skip, so the SDK import and decorators are checked, but the dataset and evaluation calls were written from the documentation and have not been run against the service. Self-hosting LangSmith is an enterprise licence feature.

Ran on 2026-11-15: SKIP. set LANGSMITH_API_KEY to trace and evaluate on LangSmith (the traced app builds fine).
