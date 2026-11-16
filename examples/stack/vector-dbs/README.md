# Vector databases

The same job in nine vector databases, on the same vectors, so the numbers compare line for line.

## The task (`shared.py`)

Every tool runs three checks through a small adapter (`create`, `insert`, `query`, `drop`):

1. **Correctness.** The Northwind handbook chunks (`common.data.chunks()`, 55 rows with `section` and `id` metadata) and the 12 gold questions are embedded once with local BGE small (`BAAI/bge-small-en-v1.5`, 384 dimensions, through fastembed) and cached in `.cache/`, so every database searches identical vectors. Each database runs the 12 questions for the top 3. The gold section must be in the top 3 for at least 11 of 12, and the top 3 is compared with brute-force cosine.
2. **Metadata filter.** The same search limited to chunks whose section is `Expenses`. The result must match brute force over the filtered rows.
3. **Scale.** 20,000 vectors of 384 dimensions inserted in batches of 1,000, then 200 queries one at a time (top 10). Reports insert time, p50 and p95 latency, and recall@10 against brute force. Insert time includes building the index (and, where needed, a flush or refresh).

The scale vectors are 100 random cluster centres plus noise, normalised, with a fixed seed. Pure uniform random vectors in 384 dimensions have almost no real neighbours, and every HNSW index scored badly on them (pgvector got recall@10 of 0.215), which says nothing about real embeddings. Clusters give the structure embeddings have and are still fully reproducible. Every index uses HNSW with cosine, M 16, ef_construction 64-100 and a search breadth of 100-200.

A tool passes if gold is at least 11/12, the filter is right and recall@10 is at least 0.8.

## Results

Run on an Apple-silicon Mac with Docker Desktop (about 8 GB), 2026-11-15, one tool at a time, with other work running on the machine. Times are one run each; insert times in particular moved a lot with machine load (pgvector took 110 s in an earlier run and 25 s here).

| Tool | Version | Gold (top 3) | Filter | Insert 20k | p50 / p95 | recall@10 | Setup weight |
|---|---|---|---|---|---|---|---|
| pgvector | PostgreSQL 17 + pgvector (lab image) | 12/12 | ok | 25.1 s | 1.6 / 2.8 ms | 1.000 | single container (the lab's own) |
| Pinecone Local | emulator `latest`, SDK 7.3.0 | 12/12 | ok | 12.6 s | 17.6 / 18.0 ms | 1.000 | 2 containers (emulator + one per index), amd64 emulated; real Pinecone is cloud only |
| Weaviate | 1.33.4 | 12/12 | ok | 2.3 s | 1.6 / 2.5 ms | 1.000 | single container |
| Qdrant, in-process | qdrant-client 1.20.0 | 12/12 | ok | 11.6 s | 9.5 / 11.8 ms | 1.000 | in-process (exact search, no HNSW) |
| Qdrant, server | 1.15.5 | 12/12 | ok | 4.4 s | 3.3 / 4.6 ms | 1.000 | single container |
| Milvus Lite | pymilvus 3.0.3, milvus-lite 3.2.2 | 12/12 | ok | 2.0 s | 7.7 / 28.5 ms | 1.000 | in-process (Standalone: 3 containers, not run) |
| Chroma | 1.5.9 | 12/12 | ok | 2.8 s | 0.9 / 1.1 ms | 1.000 | in-process |
| Elasticsearch | 9.1.5 | 12/12 | ok (+ hybrid ok) | 11.5 s | 4.6 / 9.9 ms | 1.000 | single container, 768 MB heap |
| Redis | 8.2.11 | 12/12 | ok | 5.2 s | 0.9 / 1.3 ms | 1.000 | single container, all in RAM |
| MongoDB Atlas Local | 8.0 (mongod + mongot) | 12/12 | ok | 5.1 s | 3.3 / 5.4 ms | 1.000 | single container (about 2 GB image) |

Not run: Pinecone cloud (needs `PINECONE_API_KEY`) and MongoDB Atlas cloud (needs `MONGODB_URI`). Both code paths are in the tools' `run.py` files and switch on when the variable is set.

All ten rows matched brute force on the 12 questions (top 3 identical), so at this size the choice is not about answer quality.

## How to run

```sh
python3.12 -m venv examples/stack/vector-dbs/<tool>/.venv
examples/stack/vector-dbs/<tool>/.venv/bin/pip install -r examples/stack/vector-dbs/<tool>/requirements.txt
python3 examples/stack/run_all.py vector-dbs          # all nine, one at a time; or vector-dbs/chroma for one
```

The first run builds `.cache/` (needs fastembed: `python3.12 -m venv .venv-embed && .venv-embed/bin/pip install fastembed numpy`, then `.venv-embed/bin/python shared.py`). Servers use ports 18710 to 18799 on 127.0.0.1, start from each tool's `docker-compose.yml` and are removed with `docker compose down -v` when the run ends. pgvector needs the lab's database running (`tools/vector-db.sh`); it uses its own database `stack_vectors` and drops it afterwards.

## How to choose

- **For this lab's sizes (hundreds to a few thousand chunks), pgvector or an in-process store is enough.** Every tool here answered the same 12 questions correctly, and the differences in milliseconds do not matter next to a model call that takes seconds. pgvector also gives you SQL filters, joins, transactions, row-level security and full-text search in a database you probably run already. Chroma, Qdrant in-process or Milvus Lite need no server at all and suit prototypes and tests.
- **Elasticsearch** if you already run it for text search and want keyword and vector scoring in one query. It is the heaviest to run here.
- **Redis** if the vectors are small enough for RAM and you need very low latency (caches, session or recommendation lookups).
- **Qdrant or Weaviate servers** when you have a dedicated vector workload that outgrows Postgres: millions of vectors, heavy filtering, quantisation, multi-tenancy. Both ran as a single small container.
- **Milvus Standalone or cluster** is for very large collections and a team that will operate etcd, object storage and a message queue. Milvus Lite is only the on-ramp.
- **Pinecone** if you want no operations at all and accept a managed, paid, cloud-only service. Its emulator is for functional tests, not for judging speed.
- **MongoDB Atlas Vector Search** if your data is already in MongoDB documents and you want vectors beside them.

What these numbers do not show: 20,000 vectors is small. The gaps between tools widen at millions of vectors, with concurrent writers and readers, with selective filters, and with quantisation, none of which were tested. Treat the table as "all of these work for this task and install like this", not as a ranking.
