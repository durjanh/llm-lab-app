# LlamaIndex

**What it is.** A framework for connecting data to an LLM. Its core idea: documents become nodes, nodes go into an
index, and an index gives you a query engine (retrieve, then synthesise an answer).

**How it does this task.** `chunks()` become `TextNode`s with the section in metadata. `VectorStoreIndex(nodes)` embeds
them with `HuggingFaceEmbedding` (BGE small, CPU). `index.as_query_engine(similarity_top_k=3)` retrieves; Claude
(`llama-index-llms-anthropic`) answers through a custom `text_qa_template`. Retrieval is read from `response.source_nodes`.

**Versions.** llama-index-core 0.14.26, llama-index-llms-anthropic 0.13.0, llama-index-embeddings-huggingface 0.9.0,
sentence-transformers 6.3.0, **anthropic 1.17.0** (pinned below 2).

**Limits and surprises.**
- `llama-index-llms-anthropic` 0.13.0 fails against `anthropic` 2.x (`TypeError: Cannot instantiate typing.Union`, because
  `MessageParam` became a union). Worse, the query engine hid that error and returned the string `Empty Response`, so the
  first run scored 0/12 with 12/12 retrieval hits. Pinning `anthropic<2` fixed it.
- The embedder picked the Apple GPU (MPS) and ran out of memory while Docker was busy; `device="cpu"` avoids it.
- The index is in memory and is rebuilt on each run; the 55 chunks embed in seconds.

Ran on 2026-11-15: PASS, 12/12 answers correct, 12/12 retrieval hits.
