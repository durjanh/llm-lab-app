# Observability and evaluation

Eight tools that watch or grade an LLM app. They all run the same tiny app (`shared.py`): keyword retrieval of the top two handbook chunks from `common.data`, then one `claude-haiku-5-5` answer. Each tool uses the first six `GOLD` questions, so a whole run costs a few cents.

## What each tool is for

| Tool | Kind | Where it runs | Needs |
|---|---|---|---|
| Langfuse | Tracing, scores, datasets | Self-hosted (Docker, about 2.2 GB) or Cloud | Docker, or `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` |
| Phoenix | Tracing (OpenTelemetry) and LLM-judge evals | Local process | Nothing extra |
| Weave | Tracing and evaluations | W&B cloud | `WANDB_API_KEY` |
| TruLens | Evaluation: the RAG triad | Local SQLite | Nothing extra |
| Ragas | Evaluation: RAG metrics against references | In process | Nothing extra (installs PyTorch) |
| promptfoo | Evaluation: assertions, red-team checks | `npx`, local | Node.js |
| Helicone | Gateway (proxy that logs every call) | Helicone cloud | `HELICONE_API_KEY` |
| LangSmith | Tracing, datasets and evaluation | LangSmith cloud | `LANGSMITH_API_KEY` |

Tracing tools record what happened inside a run (spans, tokens, cost). Evaluation tools score answers (faithfulness, relevance, correctness). A gateway sits between the app and the model and records calls without any code in the app. Langfuse, Phoenix, Weave and LangSmith do both tracing and some evaluation.

## Pass rules

A tracing tool passes when the traces or spans for all six questions are read back from the tool. An evaluation tool passes when it scores all six and at least five answers are judged correct.

## Results

| Tool | Result | Detail |
|---|---|---|
| helicone | SKIP | set HELICONE_API_KEY to route the six questions through Helicone (client and headers build fine) |
| langfuse | PASS | 6/6 traces read back, 6/6 with retrieval span and generation tokens, 6/6 with a score |
| langsmith | SKIP | set LANGSMITH_API_KEY to trace and evaluate on LangSmith (the traced app builds fine) |
| phoenix | PASS | 6/6 LLM spans and 6/6 retriever spans read back (1077 tokens); Phoenix correctness eval judged 6/6 correct |
| promptfoo | PASS | 6/6 gold tests passed (regex asserts, llm-rubric passed); injection check held; promptfoo 0.125.1 |
| ragas | PASS | 6/6 answers scored, 6/6 judged correct (6/6 match gold); means faithfulness 1.00, factual_correctness(mode=f1) 0.67, answer_correctness 0.75, llm_context_precision_with_reference 1.00, context_recall 1.00 |
| trulens | PASS | 6/6 records scored; Context Relevance 0.72, Groundedness 1.00, Answer Relevance 0.83; 6/6 answers match gold |
| weave | SKIP | set WANDB_API_KEY to trace and evaluate on W&B Weave (ops and evaluation build fine) |

## How to run

```sh
cd examples/stack/observability/<tool>
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd ../../../.. && python examples/stack/run_all.py observability        # all eight
python examples/stack/run_all.py observability/phoenix                  # one
```

Langfuse starts its own containers on ports 18500 and up and removes them (`docker compose down -v`) when it ends. Phoenix uses ports 18510 and 18511 while it runs. The key-based tools print SKIP, with the variable to set, until the key is present. Keys are read from the environment or the lab's `.env` and never written anywhere.
