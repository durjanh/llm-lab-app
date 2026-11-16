# TruLens (local SQLite)

**What it is.** An evaluation and tracing library from Snowflake (formerly TruEra). Its idea is the RAG triad: context relevance (did retrieval bring useful text), groundedness (is the answer supported by that text) and answer relevance (does the answer address the question).

**How it does this task.** TruLens 2.x records through OpenTelemetry. `run.py` wraps the same retrieve/generate steps with `@instrument` (retrieval, generation and record-root span types), registers the app with `TruApp`, and attaches three feedback functions. Claude is the judge through the LiteLLM provider (`anthropic/claude-haiku-5-5`). Records and feedback results go to a temporary SQLite file. The script waits for the background evaluator, then prints the leaderboard.

**Limits.** The leaderboard averages over records, so one weak answer is hidden. Judge scores move a little between runs (context relevance was 0.67 to 0.72 across three runs). `Feedback` is deprecated in favour of `Metric`, but the selector-based triad is still documented with `Feedback`.

**Seen.** Cost shows as 0.0 because LiteLLM's price map has no entry for this model. The evaluator thread can log "cannot schedule new futures after shutdown" if the process exits while it is still busy, which is why the script waits until all six records have all three scores before it exits. A warning that the baggage entry for the app is too large is harmless.

Ran on 2026-11-15: PASS. 6/6 records scored; Context Relevance 0.72, Groundedness 1.00, Answer Relevance 0.83; 6/6 answers match gold
