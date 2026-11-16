# RAG

Retrieval-augmented generation, done with six tools on the same task and the same data.

**The task.** Index the Northwind handbook (`common.data`: 12 sections, about 55 sentence chunks), then answer the 12
`GOLD` questions with retrieval and generation by Claude (`claude-haiku-5-5`). Two checks run per question: did
retrieval bring the gold section back in the top 3, and does the answer contain the gold fact. A tool **passes at 11 of 12
answers correct**; the result line also shows the retrieval hits. Embeddings are local BGE small
(`BAAI/bge-small-en-v1.5`), so only the Claude calls cost money (about 12 short calls per tool).

| Tool | What it shows | Needs |
|---|---|---|
| `llamaindex/` | `VectorStoreIndex` over nodes, then a query engine with a custom answer prompt | Claude key |
| `haystack/` | A Haystack 2 `Pipeline`: text embedder, in-memory retriever, chat prompt builder, Claude generator | Claude key |
| `dspy/` | A `dspy.Module` (retriever plus `ChainOfThought`), then one `BootstrapFewShot` step on 4 questions; both scores are reported | Claude key |
| `ragflow/` | RAGFlow's server and `ragflow-sdk`: dataset, upload, parse, chat assistant. Skips without the server | Docker, about 8 GB RAM, `RAGFLOW_API_KEY` |
| `embedchain/` | EmbedChain 0.1.128 (frozen; moved into Mem0): `App.add` and `App.query` with Chroma | Claude key |
| `unstructured/` | Parsing, not retrieval: a generated PDF and DOCX are partitioned and chunked by title, the 12 section titles must come back as `Title` elements, then a plain cosine search answers the questions | Claude key |

## Run

```sh
cd examples/stack/rag/<tool>
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd ../../../.. && python3 examples/stack/run_all.py rag      # all six, writes examples/stack/RESULTS.md
examples/stack/rag/<tool>/.venv/bin/python examples/stack/rag/<tool>/run.py   # one tool
```

`ANTHROPIC_API_KEY` comes from the lab's `.env` through `common/config.py`. The first run downloads the BGE model.
`shared.py` holds the prompt, the Claude helper and `evaluate()`, which prints one line per question and the result line.
Ports 18100 to 18199 are reserved for this area (RAGFlow uses 18100 and 18101).
