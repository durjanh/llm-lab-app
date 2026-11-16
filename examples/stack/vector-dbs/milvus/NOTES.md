# Milvus (Milvus Lite)

Milvus is a distributed vector database. Milvus Lite is the same API in a Python library that keeps its data in one local `.db` file, meant for notebooks and tests. This run uses Lite through `pymilvus`' `MilvusClient("file.db")`.

How it does the task:
- A schema with an int64 primary key, a 384-dimension float vector, and varchar `section`, `cid` and `text`; an HNSW index with COSINE (M 16, efConstruction 100, ef 128).
- The filter is a boolean expression string: `section == "Expenses"`.
- Rows are inserted in batches of 1,000, then `flush` seals the segment. Without the flush, search over the still-growing segment fell back to a brute-force scan and p50 was about 660 ms; with it, the index is used.

Milvus Standalone (the server) is **not run here**. It needs three containers: Milvus itself, etcd for metadata and MinIO for object storage (about 3 GB of memory in practice). The client code is the same; only the URI changes (`MilvusClient("http://127.0.0.1:19530")`). The cluster mode adds Pulsar or Kafka as well.

Limits: Lite has fewer index types than the server and is documented as not for production. Its p95 latency jumped more than the others, probably from background work in the same process.

Ran on 2026-11-15: PASS, gold 12/12, filter ok, insert 2.0s, p50 7.7 ms, p95 28.5 ms, recall@10 1.000. Milvus Standalone not run.
