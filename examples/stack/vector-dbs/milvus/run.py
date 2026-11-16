"""Milvus Lite: pymilvus with a local .db file (one process, no server). Milvus Standalone needs etcd and MinIO beside
it (three containers), so it is described in NOTES.md, not run here."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # vector-dbs
from common import checks, config  # noqa: E402
import shared  # noqa: E402

import shutil
import tempfile

from pymilvus import DataType, MilvusClient


class Milvus:
    def __init__(self, client):
        self.c = client

    def create(self, name, dim):
        schema = self.c.create_schema(auto_id=False, enable_dynamic_field=False)
        schema.add_field("id", DataType.INT64, is_primary=True)
        schema.add_field("vector", DataType.FLOAT_VECTOR, dim=dim)
        schema.add_field("section", DataType.VARCHAR, max_length=128)
        schema.add_field("cid", DataType.VARCHAR, max_length=128)
        schema.add_field("text", DataType.VARCHAR, max_length=2048)
        index = self.c.prepare_index_params()
        index.add_index("vector", index_type=INDEX, metric_type="COSINE", params=PARAMS)
        self.c.create_collection(name, schema=schema, index_params=index)

    def insert(self, name, ids, vectors, metas):
        rows = [{"id": i, "vector": v, "section": m["section"] if metas else "", "cid": m["id"] if metas else "",
                 "text": m["text"] if metas else ""} for i, v, m in zip(ids, vectors.tolist(), metas or [None] * len(ids))]
        self.c.insert(name, rows)

    def flush(self, name):
        self.c.flush(name)  # seals the growing segment, so the HNSW index is used instead of a brute-force scan

    def query(self, name, vector, k, section=None):
        res = self.c.search(name, data=[vector.tolist()], limit=k, search_params=SEARCH,
                            filter=f'section == "{section}"' if section else "")
        return [h["id"] for h in res[0]]

    def drop(self, name):
        self.c.drop_collection(name)


INDEX, PARAMS, SEARCH = "HNSW", {"M": 16, "efConstruction": 100}, {"params": {"ef": 128}}

if __name__ == "__main__":
    folder = tempfile.mkdtemp(prefix="stack-milvus-")
    try:
        client = MilvusClient(str(Path(folder) / "milvus.db"))
        shared.run("milvus", Milvus(client), "Milvus Lite, HNSW")
    finally:
        shutil.rmtree(folder, ignore_errors=True)
