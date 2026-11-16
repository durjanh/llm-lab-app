"""RAG with EmbedChain (embedchain 0.1.x): App.add for each chunk, App.query with Claude and local BGE embeddings.

EmbedChain's last release (0.1.128, March 2025) is frozen: the project moved into Mem0 (see NOTES.md). It still
installs on Python 3.12, so this runs it as it is.
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/rag
import shared
from shared import checks, config, data

NAME = "rag/embedchain"

if shared.need_claude(NAME):
    os.environ["ANTHROPIC_API_KEY"] = config.env("ANTHROPIC_API_KEY")  # embedchain reads it from the environment
    os.environ["ANONYMIZED_TELEMETRY"] = "False"
    try:
        from embedchain import App
    except Exception as e:  # the package moved or no longer imports
        checks.skip(NAME, f"embedchain does not import any more ({type(e).__name__}); Mem0 replaced it, see NOTES.md")
        raise SystemExit(0)

    with tempfile.TemporaryDirectory() as tmp:
        app = App.from_config(config={
            "app": {"config": {"name": "stack-rag-embedchain", "collect_metrics": False}},
            "llm": {"provider": "anthropic", "config": {
                "model": config.CLAUDE_MODEL, "max_tokens": 150, "number_documents": 3,
                "prompt": shared.SYSTEM + "\n\nHandbook excerpts:\n$context\n\nQuestion: $query\nAnswer:"}},
            "embedder": {"provider": "huggingface", "config": {"model": config.LOCAL_EMBEDDING, "model_kwargs": {"device": "cpu"}}},
            "vectordb": {"provider": "chroma", "config": {"collection_name": "northwind", "dir": tmp, "allow_reset": True}},
        })
        # The config schema insists on a float, but claude-haiku-5-5 rejects `temperature`; clear it after validation.
        app.llm.config.temperature = None
        for c in data.chunks():
            app.add(c.text, data_type="text", metadata={"section": c.section})

        def answer(question):
            text, sources = app.query(question, citations=True)
            return text, [meta.get("section", "") for _, meta in sources]

        shared.evaluate(NAME, answer, "embedchain 0.1.128 App, chroma, top 3")
        app.reset()
