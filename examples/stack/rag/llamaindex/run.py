"""RAG with LlamaIndex: a VectorStoreIndex over the handbook chunks and a query engine that answers with Claude."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/rag
import shared
from shared import checks, config, data

NAME = "rag/llamaindex"

if shared.need_claude(NAME):
    from llama_index.core import Settings, VectorStoreIndex
    from llama_index.core.prompts import PromptTemplate
    from llama_index.core.schema import TextNode
    from llama_index.embeddings.huggingface import HuggingFaceEmbedding
    from llama_index.llms.anthropic import Anthropic

    Settings.embed_model = HuggingFaceEmbedding(model_name=config.LOCAL_EMBEDDING, device="cpu")
    Settings.llm = Anthropic(model=config.CLAUDE_MODEL, max_tokens=150)

    # One node per handbook chunk; the section title travels as metadata so we can check retrieval.
    nodes = [TextNode(id_=c.id, text=c.text, metadata={"section": c.section}) for c in data.chunks()]
    index = VectorStoreIndex(nodes)
    engine = index.as_query_engine(similarity_top_k=3)
    engine.update_prompts({"response_synthesizer:text_qa_template": PromptTemplate(
        shared.SYSTEM + "\n\nHandbook excerpts:\n{context_str}\n\nQuestion: {query_str}\nAnswer: ")})

    def answer(question):
        response = engine.query(question)
        return str(response), [n.node.metadata["section"] for n in response.source_nodes]

    shared.evaluate(NAME, answer, "VectorStoreIndex, top 3")
