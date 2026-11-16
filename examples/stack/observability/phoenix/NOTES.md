# Arize Phoenix (local)

**What it is.** An open-source tracing and evaluation app from Arize. It takes OpenTelemetry spans (OpenInference conventions) and has an evals library with LLM judges.

**How it does this task.** `run.py` starts the Phoenix server as a child process on `127.0.0.1:18510` (gRPC 18511) with its data in a temporary folder and telemetry off. `openinference-instrumentation-anthropic` patches the Anthropic SDK, so each Claude call becomes an `LLM` span with tokens. A manual `RETRIEVER` span wraps retrieval. The spans are read back with the Phoenix client (`spans.get_spans_dataframe`). Then `phoenix.evals` runs `CorrectnessEvaluator` with Claude as the judge on each question, its retrieved context and its answer.

**Limits.** Phoenix is a heavy install (SQLAlchemy, gRPC, a web app). The correctness evaluator judges one answer against its context, with no gold reference. The gold patterns are printed next to the judge's labels so the two can be compared.

**Seen.** Passing `temperature=0.0` to the evaluator failed (the Anthropic provider's client rejected the keyword, and the model API itself rejects `temperature`), so the evaluator runs with its defaults. The pip resolver chose `anthropic` 1.17 here, older than the 2.x in the other folders, and it works.

Ran on 2026-11-15: PASS. 6/6 LLM spans and 6/6 retriever spans read back (1077 tokens); Phoenix correctness eval judged 6/6 correct
