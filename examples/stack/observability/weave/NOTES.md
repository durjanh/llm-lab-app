# W&B Weave

**What it is.** Weights & Biases' tracing and evaluation toolkit for LLM apps. `@weave.op` records inputs, outputs and nested calls. `weave.Evaluation` runs a model over a dataset with scorers and stores the summary.

**How it does this task.** `run.py` defines a `retrieve` op, a `weave.Model` whose `predict` op retrieves and calls Claude (Weave patches the Anthropic SDK, so the call is a child op with usage), and two scorer ops: `gold_match` (the gold pattern) and `grounded_in_context` (every number in the answer appears in the retrieved text). `weave.Evaluation(dataset, scorers)` runs the six questions. PASS needs at least five correct.

**Limits.** It needs a W&B account and `WANDB_API_KEY`. There is no local-only mode for the hosted UI (a self-managed W&B server exists but is a paid, heavy install).

**Not run.** `WANDB_API_KEY` is not set here, so this printed SKIP. The ops and the evaluation are built before the skip, which checks that the code imports and the scorers type-check against the Weave version pinned in `requirements.txt`. It has not been run against W&B.

Ran on 2026-11-15: SKIP. set WANDB_API_KEY to trace and evaluate on W&B Weave (ops and evaluation build fine).
