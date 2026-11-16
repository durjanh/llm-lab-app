# Qdrant

A vector database written in Rust. It has three modes with the same client API: in-process (`QdrantClient(path=...)`), a server (Docker image), and Qdrant Cloud.

How it does the task:
- In-process first: `QdrantClient(path=<temp folder>)`. This mode is for tests and small data. It does **not** build an HNSW index: it scores every vector with numpy, so it is exact and its latency grows with the data.
- Then the server (`qdrant/qdrant:v1.15.5`, port 18740) for the same benchmark, with a real HNSW index (m 16, ef_construct 100, search `hnsw_ef` 128) and a keyword payload index on `section`.
- The filter is a `Filter(must=[FieldCondition(...)])` passed to `query_points`. Qdrant filters while it walks the graph, so a selective filter does not lose results.
- Both runs print their own numbers; the result line carries both.

Limits: the in-process mode and the server are separate code paths (the in-process one ignores index settings), so a good in-process result does not prove the server's behaviour.

Ran on 2026-11-15: PASS. In-process: insert 11.6s, p50 9.5 ms, p95 11.8 ms, recall@10 1.000 (exact search). Server: insert 4.4s, p50 3.3 ms, p95 4.6 ms, recall@10 1.000. Both gold 12/12, filter ok.
