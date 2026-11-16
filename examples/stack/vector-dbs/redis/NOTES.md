# Redis (query engine)

Redis 8 has the query engine (search, JSON, vector) built in, so there is no separate Redis Stack image. Data lives in memory.

How it does the task:
- `redis:8.2` in Docker (port 18780, 512 MB limit), no password, 127.0.0.1 only.
- Each row is a hash (`stack_small:3`) with a `vec` field of raw float32 bytes, a TAG field `section` and a TEXT field. The index is `FT.CREATE ... VECTOR HNSW` with DIM 384, COSINE, M 16, EF_CONSTRUCTION 100, EF_RUNTIME 128, built in the background as rows arrive.
- Search is `FT.SEARCH idx "(@section:{Expenses})=>[KNN 3 @vec $v AS score]" DIALECT 2`, so the filter and the KNN are one query. TAG values need spaces escaped (`Annual\ leave`).
- redis-py's search commands are used directly; RedisVL would wrap the same calls.

Limits: everything must fit in RAM, and indexing is asynchronous (the run waits until `indexing` is 0). Persistence (RDB, AOF) is off in this run.

Ran on 2026-11-15: PASS, gold 12/12, filter ok, insert 5.2s, p50 0.9 ms, p95 1.3 ms, recall@10 1.000 (Redis 8.2.11).
