# Haystack

**What it is.** deepset's framework for pipelines of typed components. You add components to a `Pipeline`, connect
named outputs to named inputs, and run it with a dict of inputs.

**How it does this task.** Chunks become `Document`s (section in `meta`) and are embedded once into an
`InMemoryDocumentStore`. The query pipeline is `SentenceTransformersTextEmbedder` -> `InMemoryEmbeddingRetriever`
(top 3) -> `ChatPromptBuilder` -> `AnthropicChatGenerator`. `include_outputs_from={"retriever"}` returns the retrieved
documents next to the reply, which is how retrieval is checked.

**Versions.** haystack-ai 3.5.0, anthropic-haystack 8.1.0, sentence-transformers-haystack 2.2.0,
sentence-transformers 6.3.0, anthropic 2.8.0.

**Limits and surprises.**
- In Haystack 3 the sentence-transformers embedders are no longer in `haystack-ai`; they live in the separate
  `sentence-transformers-haystack` package (`haystack_integrations...`). Older tutorials import them from
  `haystack.components.embedders` and fail.
- `anthropic-haystack` has chat generators only (`AnthropicChatGenerator`), so the prompt builder must be a
  `ChatPromptBuilder` that makes `ChatMessage`s.
- Embedders use `ComponentDevice.from_str("cpu")` because the Apple GPU ran out of memory.

Ran on 2026-11-15: PASS, 12/12 answers correct, 12/12 retrieval hits.
