# Weaviate

An open-source vector database written in Go, with its own schema ("collections"), a gRPC and REST API, and optional modules that call embedding models. This run uses none of the modules and brings its own vectors.

How it does the task:
- One container (`cr.weaviate.io/semitechnologies/weaviate:1.33.4`, ports 18750 and 18751, Go memory limit 600 MiB, container limit 1 GB), anonymous access on 127.0.0.1.
- A collection with `self_provided` vectors, HNSW cosine (max connections 16, ef_construction 100, ef 128). `section` has FIELD tokenisation so a section title is matched whole, not word by word.
- Weaviate ids must be UUIDs, so each row's id is `UUID(int=i)` and the integer is also stored as property `n`.
- Search is `near_vector` with a `Filter.by_property("section").equal(...)`.

Limits: the server needs a moment before it answers HTTP, and `connect_to_local` checks at once, so run.py polls `/v1/.well-known/ready` first. Weaviate also does hybrid (BM25 plus vector) search; this task does not use it.

Ran on 2026-11-15: PASS, gold 12/12, filter ok, insert 2.3s, p50 1.6 ms, p95 2.5 ms, recall@10 1.000.
