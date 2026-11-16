# EmbedChain

**What it is.** A small RAG library: `App.add(source)` loads, chunks, embeds and stores; `App.query(question)` retrieves and
answers. It was merged into Mem0.

**Current state (checked 2026-11-15).** PyPI's `embedchain` last release is 0.1.128 (25 March 2025), and the GitHub API
returns 404 for an `embedchain/` folder in `mem0ai/mem0` today. The package depends on `mem0ai`, and the maintainers'
direction is Mem0 (memory for agents) instead. It is not maintained for new models, but it still installs and runs on
Python 3.12 (it declares `<=3.13.2`), so this does the task with it. What replaced it for RAG is a framework such as
LlamaIndex or Haystack (see the siblings here); Mem0 itself is a memory layer, see the `memory` area.

**How it does this task.** `App.from_config` with `llm: anthropic`, `embedder: huggingface` (BGE small) and
`vectordb: chroma` in a temp folder. Each chunk goes in with `app.add(text, data_type="text", metadata={"section": ...})`.
`app.query(q, citations=True)` returns the answer and the retrieved chunks, with `number_documents=3`.

**Versions.** embedchain 0.1.128, langchain-anthropic 0.3.22, langchain-huggingface 0.1.2, chromadb 0.5.23,
sentence-transformers 5.7.0, anthropic 0.125.0.

**Limits and surprises.**
- Neither `langchain-anthropic` nor `langchain-huggingface` is installed with it; the first import errors say so.
- It always sends a `temperature`, and `claude-haiku-5-5` rejects it (HTTP 400, "temperature is deprecated for this
  model"). The config schema only accepts a float, so `run.py` sets `app.llm.config.temperature = None` after the app
  is built. That is a workaround for a frozen package.
- It prints a pydantic deprecation warning on every query. Embeddings run on the CPU (Apple GPU ran out of memory).

Ran on 2026-11-15: PASS, 12/12 answers correct, 12/12 retrieval hits.
