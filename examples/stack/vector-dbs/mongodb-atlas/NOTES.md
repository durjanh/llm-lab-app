# MongoDB Atlas Vector Search

Vector search inside MongoDB: a `vectorSearch` index on a collection and the `$vectorSearch` aggregation stage. In Atlas the index is served by `mongot`, a separate Lucene-based search process.

How it does the task:
- The official `mongodb/mongodb-atlas-local:8.0` image (arm64 build exists, about 2 GB) runs `mongod` and `mongot` in one container on port 18790, no credentials, 127.0.0.1 only.
- The index definition has a `vector` field (384 dimensions, cosine) and a `filter` field `section`. `$vectorSearch` takes `numCandidates` (the ANN breadth) and `limit`, and a `filter` using MongoDB match operators (`{"section": {"$eq": ...}}`).
- Search indexes build after the documents are written, so `flush` polls until the last inserted vector is found.
- With `MONGODB_URI` set (an Atlas cluster), the same benchmark runs there too, in a database named `stack_vectors` that is dropped afterwards. That path was written but not run here, because there is no cluster.

Surprise: `mongod` answers before `mongot` is ready, and the first search-index command then fails ("Error connecting to Search Index Management service", then "mongot is shutting down"). The run waits for the container's own healthcheck to say healthy.

Limits: `$vectorSearch` works only on Atlas or Atlas Local, not on plain community MongoDB.

Ran on 2026-11-15: PASS against Atlas Local 8.0, gold 12/12, filter ok, insert 5.1s, p50 3.3 ms, p95 5.4 ms, recall@10 1.000. Cloud path not run (no MONGODB_URI).
