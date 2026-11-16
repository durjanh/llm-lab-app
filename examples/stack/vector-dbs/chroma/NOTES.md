# Chroma

An open-source embedding database aimed at getting started quickly: one `PersistentClient(path=...)` call, no server. It uses HNSW (hnswlib) inside the process, with the data in SQLite plus index files.

How it does the task:
- A collection with `configuration={"hnsw": {"space": "cosine", "ef_construction": 100, "ef_search": 100, "max_neighbors": 16}}`. Chroma 1.x moved these settings from `metadata={"hnsw:space": ...}` to `configuration`.
- Ids are strings, so rows use `str(i)`. Metadata is `section` and `cid`; the filter is `where={"section": ...}`.
- Everything runs in a temporary folder that is removed at the end.

Limits: one process owns the folder. Chroma also has a client-server mode and Chroma Cloud, which this run does not use.

Ran on 2026-11-15: PASS, gold 12/12, filter ok, insert 2.8s, p50 0.9 ms, p95 1.1 ms, recall@10 1.000 (chromadb 1.5.9).
