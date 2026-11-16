# Elasticsearch

A search engine (Lucene) that also stores dense vectors. People choose it when they already run it for text search and want vectors and keywords in one query.

How it does the task:
- One node in Docker (`docker.elastic.co/elasticsearch/elasticsearch:9.1.5`, port 18770) with **security switched off**. That is for this local run only: it binds to 127.0.0.1, has no password, and must never be exposed. Heap is 768 MB, container limit 1.5 GB, machine learning off.
- A `dense_vector` field with `similarity: cosine` and HNSW index options (m 16, ef_construction 100); `section` is a `keyword` field and `text` a `text` field.
- Search is the top-level `knn` option (`k`, `num_candidates` 200); the filter goes inside `knn.filter`, so it applies during the graph search. Refresh is off while loading and switched on once, which made loading much faster.
- **Hybrid:** one request carries a BM25 `match` query on the text and a `knn` clause; Elasticsearch adds the two scores. The run asks for "report phishing button" with the matching question vector and checks the Information security chunk is first.

Surprise: Reciprocal Rank Fusion (the `rrf` retriever) answered 403 "current license is non-compliant", so it needs a paid licence (or a trial). The score-adding hybrid works on the free licence.

Limits: slowest to start (about 30 to 60 seconds) and the heaviest container here. Vectors are also quantised by default in newer versions for large indexes; this run uses plain float32.

Ran on 2026-11-15: PASS, gold 12/12, filter ok, hybrid ok, insert 11.5s, p50 4.6 ms, p95 9.9 ms, recall@10 1.000 (Elasticsearch 9.1.5).
