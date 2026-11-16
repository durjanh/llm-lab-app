"""Redis 8 query engine: a hash per row, an HNSW vector field and a TAG field for the filter, searched with FT.SEARCH."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # vector-dbs
from common import checks, config  # noqa: E402
import shared  # noqa: E402

import re

import numpy as np
import redis
from redis.commands.search.field import TagField, TextField, VectorField
from redis.commands.search.index_definition import IndexDefinition, IndexType
from redis.commands.search.query import Query

HERE = Path(__file__).resolve().parent
PORT = config.PORTS["vector-dbs"][0] + 80  # 18780


def tag(value: str) -> str:
    """Escape punctuation and spaces in a TAG value."""
    return re.sub(r"([^A-Za-z0-9_])", r"\\\1", value)


class Redis:
    def __init__(self, r):
        self.r = r

    def create(self, name, dim):
        schema = (TagField("section"), TextField("text"),
                  VectorField("vec", "HNSW", {"TYPE": "FLOAT32", "DIM": dim, "DISTANCE_METRIC": "COSINE", "M": 16,
                                              "EF_CONSTRUCTION": 100, "EF_RUNTIME": 128}))
        self.r.ft(name).create_index(schema, definition=IndexDefinition(prefix=[f"{name}:"], index_type=IndexType.HASH))

    def insert(self, name, ids, vectors, metas):
        pipe = self.r.pipeline(transaction=False)
        for i, v, m in zip(ids, vectors, metas or [None] * len(ids)):
            doc = {"vec": v.astype(np.float32).tobytes(), "section": m["section"] if m else "none", "text": m["text"] if m else ""}
            pipe.hset(f"{name}:{i}", mapping=doc)
        pipe.execute()

    def flush(self, name):
        shared.wait_for(lambda: int(self.r.ft(name).info()["indexing"]) == 0, "Redis indexing", 120)  # background indexing

    def query(self, name, vector, k, section=None):
        base = f"(@section:{{{tag(section)}}})" if section else "*"
        q = Query(f"{base}=>[KNN {k} @vec $v EF_RUNTIME 128 AS score]").sort_by("score").return_fields("score").dialect(2).paging(0, k)
        res = self.r.ft(name).search(q, query_params={"v": vector.astype(np.float32).tobytes()})
        return [int(d.id.split(":")[1]) for d in res.docs]

    def drop(self, name):
        self.r.ft(name).dropindex(delete_documents=True)


if __name__ == "__main__":
    try:
        shared.compose(HERE, "up", "-d")
        r = redis.Redis(port=PORT, host="127.0.0.1")
        shared.wait_for(r.ping, "Redis")
        version = r.info("server")["redis_version"]
        ok, detail = shared.measure(Redis(r))
        checks.report("vector-dbs/redis", ok, f"{detail} (Redis {version}, HNSW, FT.SEARCH)")
    finally:
        shared.compose(HERE, "down", "-v")
