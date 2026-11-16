# RAGFlow

**What it is.** InfiniFlow's open-source RAG engine, run as a server with a web UI: deep document parsing, templated
chunking, an Elasticsearch (or Infinity) index, MySQL, MinIO and Redis behind it. You work through the UI or `ragflow-sdk`.

**How `run.py` does this task.** `RAGFlow(api_key, base_url)`; `create_dataset` (naive chunking); `upload_documents` with
one text document per handbook section; `async_parse_documents`, then wait for each document to reach `DONE`;
`create_chat` over the dataset and `session.ask` for answers; `rag.retrieve(..., page_size=3)` for the retrieval check
(the document name is the section). It deletes the chat and the dataset at the end.

**What was run.** Only the SKIP path. Docker has 7.7 GB, and `stack-vector-dbs-pinecone`, `stack-automation-kestra` and
`stack-automation-kestra-crm` were already running next to the lab's own two containers. RAGFlow wants about 8 GB on its
own, so it was not started. `run.py` imports `ragflow_sdk` (so the client code at least imports) and skips unless
`RAGFLOW_API_KEY` is set and the API port answers. The SDK calls were checked against the installed 0.26.0
signatures but **not run against a server**, so treat the code as unproven.

**To run it.** `docker compose -f examples/stack/rag/ragflow/docker-compose.yml up -d`, open http://127.0.0.1:18100,
sign up, add Anthropic as a model provider and choose it as the chat model, make an API key, export `RAGFLOW_API_KEY`,
run `run.py`, then `docker compose ... down -v`. The compose file is a cut-down reference (image tags are from memory of
RAGFlow's own `docker/` folder, not tested); for a real setup start from that folder. It uses the slim image, which has
no built-in embedding model, so an embedding model must be configured in the UI too.

**Versions.** ragflow-sdk 0.26.0.

Ran on 2026-11-15: SKIP, needs the RAGFlow server (docker compose up, about 8 GB RAM).
