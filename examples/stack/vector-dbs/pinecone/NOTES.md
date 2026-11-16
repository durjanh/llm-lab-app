# Pinecone

A managed vector database. You never run it; you call an index by host with an API key. Pinecone Local is the official emulator for development.

How it does the task:
- `ghcr.io/pinecone-io/pinecone-local` is started by `docker-compose.yml` on port 18710. It has no vector code of its own: for each index you create it starts another container (`pinecone-index`) on the next port, through the Docker socket, so the compose file mounts `/var/run/docker.sock`. Both images are amd64 only; on Apple silicon Docker runs them under emulation, and that worked.
- Indexes are cosine, created with a `ServerlessSpec` (the emulator accepts and ignores it). Rows are upserted 200 at a time (a request is limited to 2 MB) with `section` as metadata. The filter is `{"section": {"$eq": ...}}`.
- Upserts are eventually consistent, so `flush` waits until `describe_index_stats` counts every row.
- With `PINECONE_API_KEY` set, the same benchmark also runs against Pinecone's cloud (serverless, AWS us-east-1) and deletes its indexes. That path was written but not run here, because there is no key.

Surprise: the current SDK (10.x) sends an index-creation body the emulator rejects (`missing field dimension`), so this folder pins `pinecone==7.3.0`, which both the emulator and the cloud accept.

Limits: the emulator is for functional tests, not speed or scale, and it does not model Pinecone's namespaces' limits, costs or consistency delays. Needs Docker with the socket available.

Ran on 2026-11-15: PASS against Pinecone Local (pinecone==7.3.0), gold 12/12, filter ok, insert 12.6s, p50 17.6 ms, p95 18.0 ms, recall@10 1.000. Cloud path not run (no PINECONE_API_KEY).
