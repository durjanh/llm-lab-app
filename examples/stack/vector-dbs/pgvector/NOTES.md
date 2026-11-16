# pgvector (baseline)

PostgreSQL with the pgvector extension, the same database the lab's own vector page uses (`backend/app/gateways/pgvector.py`). The run makes a separate database, `stack_vectors`, inside the lab's `llm-lab-pgvector` container (`pgvector/pgvector:pg17`, port 5433) and drops it at the end. The container itself is not touched.

How it does the task:
- A table with `section`, `cid`, `content` and `embedding vector(384)`, and an HNSW index with `vector_cosine_ops` (m 16, ef_construction 64, `hnsw.ef_search` 100), as in the lab.
- Search is `ORDER BY embedding <=> $1 LIMIT k`. The filter is a plain `WHERE section = ...`, so metadata filtering is ordinary SQL.
- Rows go in with binary `COPY`.

Limits: the filter runs after the index scan, so a very selective filter on a large table can return fewer than k rows unless `ef_search` is raised (newer pgvector has iterative scans for this). Building the HNSW index row by row is the slow part of loading; for a big load, copy first and build the index after.

Needs the lab's database running (`tools/vector-db.sh`). Without it the run prints SKIP.

Ran on 2026-11-15: PASS, gold 12/12, filter ok, insert 25.1s, p50 1.6 ms, p95 2.8 ms, recall@10 1.000. Surprise: an earlier run, with other containers busy, took 110 s to insert and p50 was 5.6 ms, so insert times here move a lot with machine load. Also, 20,000 uniform random vectors in 384 dimensions gave recall@10 of only 0.215 at ef_search 40, which is why the benchmark uses clustered vectors (see README).
