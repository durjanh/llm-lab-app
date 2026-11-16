"""Weaviate in Docker with no vectoriser module: our own vectors, an HNSW cosine index, a property filter."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # vector-dbs
from common import checks, config  # noqa: E402
import shared  # noqa: E402

import urllib.request
import uuid

import weaviate
from weaviate.classes.config import Configure, DataType, Property, Tokenization, VectorDistances
from weaviate.classes.query import Filter, MetadataQuery

HERE = Path(__file__).resolve().parent
HTTP, GRPC = config.PORTS["vector-dbs"][0] + 50, config.PORTS["vector-dbs"][0] + 51  # 18750, 18751


class Weaviate:
    def __init__(self, client):
        self.c = client

    def create(self, name, dim):
        self.c.collections.create(
            name, vector_config=Configure.Vectors.self_provided(vector_index_config=Configure.VectorIndex.hnsw(
                distance_metric=VectorDistances.COSINE, max_connections=16, ef_construction=100, ef=128)),
            properties=[Property(name="n", data_type=DataType.INT),
                        Property(name="section", data_type=DataType.TEXT, tokenization=Tokenization.FIELD),
                        Property(name="cid", data_type=DataType.TEXT, tokenization=Tokenization.FIELD),
                        Property(name="text", data_type=DataType.TEXT)])

    def insert(self, name, ids, vectors, metas):
        from weaviate.classes.data import DataObject
        objs = [DataObject(uuid=uuid.UUID(int=i), vector=v.tolist(),
                           properties={"n": i, **({"section": m["section"], "cid": m["id"], "text": m["text"]} if m else {})})
                for i, v, m in zip(ids, vectors, metas or [None] * len(ids))]
        res = self.c.collections.get(name).data.insert_many(objs)
        if res.has_errors:
            raise RuntimeError(list(res.errors.values())[0])

    def query(self, name, vector, k, section=None):
        res = self.c.collections.get(name).query.near_vector(
            vector.tolist(), limit=k, filters=Filter.by_property("section").equal(section) if section else None)
        return [o.properties["n"] for o in res.objects]

    def drop(self, name):
        self.c.collections.delete(name)


if __name__ == "__main__":
    try:
        shared.compose(HERE, "up", "-d")
        shared.wait_for(lambda: urllib.request.urlopen(f"http://127.0.0.1:{HTTP}/v1/.well-known/ready", timeout=3).status == 200, "Weaviate")
        client = weaviate.connect_to_local(host="127.0.0.1", port=HTTP, grpc_port=GRPC)
        version = client.get_meta()["version"]
        ok, detail = shared.measure(Weaviate(client))
        client.close()
        checks.report("vector-dbs/weaviate", ok, f"{detail} (Weaviate {version}, own vectors)")
    finally:
        shared.compose(HERE, "down", "-v")
