"""Qdrant: in-process mode first (QdrantClient(path=...), which is exact search in numpy), then the server in Docker
(real HNSW) for the same benchmark."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # vector-dbs
from common import checks, config  # noqa: E402
import shared  # noqa: E402

import shutil
import tempfile

from qdrant_client import QdrantClient, models

HERE = Path(__file__).resolve().parent
PORT = config.PORTS["vector-dbs"][0] + 40  # 18740


class Qdrant:
    def __init__(self, client: QdrantClient):
        self.q = client

    def create(self, name, dim):
        self.q.create_collection(name, vectors_config=models.VectorParams(size=dim, distance=models.Distance.COSINE),
                                 hnsw_config=models.HnswConfigDiff(m=16, ef_construct=100))
        self.q.create_payload_index(name, "section", models.PayloadSchemaType.KEYWORD)

    def insert(self, name, ids, vectors, metas):
        payloads = metas or [{} for _ in ids]
        self.q.upsert(name, points=models.Batch(ids=ids, vectors=vectors.tolist(), payloads=payloads), wait=True)

    def query(self, name, vector, k, section=None):
        flt = models.Filter(must=[models.FieldCondition(key="section", match=models.MatchValue(value=section))]) if section else None
        res = self.q.query_points(name, query=vector.tolist(), limit=k, query_filter=flt,
                                  search_params=models.SearchParams(hnsw_ef=128))
        return [p.id for p in res.points]

    def drop(self, name):
        self.q.delete_collection(name)


if __name__ == "__main__":
    folder = tempfile.mkdtemp(prefix="stack-qdrant-")
    client = QdrantClient(path=folder)
    ok1, d1 = shared.measure(Qdrant(client), "in-process")
    client.close()
    shutil.rmtree(folder, ignore_errors=True)

    ok2, d2 = True, ""
    try:
        shared.compose(HERE, "up", "-d")
        server = QdrantClient(host="127.0.0.1", port=PORT, prefer_grpc=False, timeout=60)
        shared.wait_for(lambda: server.get_collections() is not None, "Qdrant")
        ok2, d2 = shared.measure(Qdrant(server), "server")
        server.close()
    finally:
        shared.compose(HERE, "down", "-v")
    checks.report("vector-dbs/qdrant", ok1 and ok2, f"in-process: {d1}; server: {d2}")
