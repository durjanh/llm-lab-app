# DSPy

**What it is.** Stanford's framework for programming, not prompting, language models. You declare a signature (inputs and
outputs), wrap it in a module, and an optimiser can then tune the prompt (instructions, few-shot demos) against a metric.

**How it does this task.** `dspy.retrievers.Embeddings` retrieves the top 3 chunks with BGE small (a callable that wraps
sentence-transformers). The `RAG` module passes them to `dspy.ChainOfThought(Handbook)`, a signature of
`context, question -> answer`. `dspy.LM("anthropic/claude-haiku-5-5")` is the model.

**Optimisation step.** `BootstrapFewShot` ran with a metric that is the gold regex, on 4 questions (every third one) and
`max_bootstrapped_demos=2`. It keeps traces that the metric accepts as few-shot demos. The result line reports the tuned
score and the unoptimised score. The unoptimised program already answered everything, so the step shows the mechanism
but cannot show an improvement here; the 4 training questions are also in the test set, so treat the tuned score as a
smoke test, not a fair measurement. It cost about 20 extra short calls.

**Versions.** dspy 3.5.0, sentence-transformers 6.3.0.

**Limits and surprises.**
- `claude-haiku-5-5` rejects `temperature=0` ("temperature may only be set to 1 when thinking is enabled"), so no
  temperature is set. DSPy's own cache is off (`cache=False`) so each run is a real run.
- Embeddings run on the CPU; the Apple GPU ran out of memory.

Ran on 2026-11-15: PASS, 12/12 answers correct and 12/12 retrieval hits after optimisation; 12/12 before.
