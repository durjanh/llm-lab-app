# Langfuse (self-hosted)

**What it is.** An open-source tracing and evaluation platform for LLM apps. Traces hold nested observations (spans, generations, retrievers) with token usage, cost and scores. Version 3 needs Postgres, ClickHouse, Redis and MinIO next to the web and worker containers.

**How it does this task.** `docker-compose.yml` starts all six containers on `127.0.0.1:18500` with throwaway passwords. `LANGFUSE_INIT_*` creates the organisation, project and API keys on first start, so no sign-up is needed. `run.py` traces each of the six questions with the Python SDK (a root span, a `retriever` observation, and a `generation` with `usage_details` and `cost_details`), adds a `gold-match` score per trace, then polls `/api/public/traces/<id>` until every trace has its retrieval span, generation tokens and score. It ends with `docker compose down -v`. If `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_HOST` are set it uses Langfuse Cloud instead and starts nothing. With no Docker and no cloud keys it prints SKIP.

**Limits.** About 2.2 GB of Docker memory at rest. The first start pulls six images and takes a few minutes. Ingestion is asynchronous (S3, then the worker, then ClickHouse), so reading back needs a short poll.

**Seen.** Three things. (1) The web container ran out of memory at a 1 GB limit (Node heap), so the compose file gives it 2 GB and a 1.25 GB heap. (2) On a cold start the web container ran its ClickHouse migrations before ClickHouse was listening and exited, so the compose file now has health checks for ClickHouse and Postgres, and `restart: on-failure`. (3) The newest SDK (5.x) traced fine but its scores were rejected with a 400 by the v3 server ("expected object, received array"), so the SDK is pinned to 3.15, which matches the `langfuse:3` images. Use SDK 5 only with a newer server or Langfuse Cloud.

Ran on 2026-11-15: PASS. 6/6 traces read back, 6/6 with retrieval span and generation tokens, 6/6 with a score
