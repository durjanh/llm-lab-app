"""RAG with Haystack 2.x: a pipeline of text embedder, in-memory retriever, prompt builder and Claude generator."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/rag
import shared
from shared import checks, config, data

NAME = "rag/haystack"

if shared.need_claude(NAME):
    from haystack import Document, Pipeline
    from haystack.components.builders import ChatPromptBuilder
    from haystack.dataclasses import ChatMessage
    from haystack.utils import ComponentDevice
    from haystack_integrations.components.embedders.sentence_transformers import (
        SentenceTransformersDocumentEmbedder, SentenceTransformersTextEmbedder)
    from haystack.components.retrievers.in_memory import InMemoryEmbeddingRetriever
    from haystack.document_stores.in_memory import InMemoryDocumentStore
    from haystack_integrations.components.generators.anthropic import AnthropicChatGenerator

    store = InMemoryDocumentStore()
    docs = [Document(id=c.id, content=c.text, meta={"section": c.section}) for c in data.chunks()]
    doc_embedder = SentenceTransformersDocumentEmbedder(model=config.LOCAL_EMBEDDING, device=ComponentDevice.from_str("cpu"))
    doc_embedder.warm_up()
    store.write_documents(doc_embedder.run(docs)["documents"])

    template = [ChatMessage.from_user(shared.SYSTEM + """

Handbook excerpts:
{% for d in documents %}[{{ loop.index }}] {{ d.content }}
{% endfor %}
Question: {{ question }}""")]

    pipe = Pipeline()
    pipe.add_component("embedder", SentenceTransformersTextEmbedder(model=config.LOCAL_EMBEDDING, device=ComponentDevice.from_str("cpu")))
    pipe.add_component("retriever", InMemoryEmbeddingRetriever(document_store=store, top_k=3))
    pipe.add_component("prompt", ChatPromptBuilder(template=template))
    pipe.add_component("llm", AnthropicChatGenerator(model=config.CLAUDE_MODEL, generation_kwargs={"max_tokens": 150}))
    pipe.connect("embedder.embedding", "retriever.query_embedding")
    pipe.connect("retriever.documents", "prompt.documents")
    pipe.connect("prompt", "llm")

    def answer(question):
        out = pipe.run({"embedder": {"text": question}, "prompt": {"question": question}},
                       include_outputs_from={"retriever"})
        return out["llm"]["replies"][0].text, [d.meta["section"] for d in out["retriever"]["documents"]]

    shared.evaluate(NAME, answer, "Pipeline: embedder, retriever, prompt builder, generator")
