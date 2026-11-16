"""MongoDB Atlas Vector Search: the official mongodb-atlas-local image (mongod plus mongot) and $vectorSearch with a
vector index. If MONGODB_URI is set, the same benchmark also runs against that Atlas cluster (collections dropped
afterwards)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # vector-dbs
from common import checks, config  # noqa: E402
import shared  # noqa: E402

import subprocess

import numpy as np
from pymongo import MongoClient
from pymongo.operations import SearchIndexModel

HERE = Path(__file__).resolve().parent
PORT = config.PORTS["vector-dbs"][0] + 90  # 18790


class Mongo:
    def __init__(self, db):
        self.db, self.last = db, {}

    def create(self, name, dim):
        self.db.create_collection(name)
        model = SearchIndexModel(name="vec", type="vectorSearch", definition={"fields": [
            {"type": "vector", "path": "embedding", "numDimensions": dim, "similarity": "cosine"},
            {"type": "filter", "path": "section"}]})
        self.db[name].create_search_index(model)

    def insert(self, name, ids, vectors, metas):
        metas = metas or [None] * len(ids)
        self.db[name].insert_many([{"_id": i, "embedding": v.tolist(), **({"section": m["section"], "cid": m["id"], "text": m["text"]} if m else {})}
                                   for i, v, m in zip(ids, vectors, metas)])
        self.last[name] = (ids[-1], vectors[-1])

    def flush(self, name):  # the index follows the collection a moment later: wait until the last row is found
        last_id, vec = self.last[name]
        shared.wait_for(lambda: self.query(name, vec, 1) == [last_id], "Atlas vector index", 300)

    def query(self, name, vector, k, section=None):
        stage = {"index": "vec", "path": "embedding", "queryVector": vector.tolist(), "numCandidates": max(200, k * 20), "limit": k}
        if section:
            stage["filter"] = {"section": {"$eq": section}}
        return [d["_id"] for d in self.db[name].aggregate([{"$vectorSearch": stage}, {"$project": {"_id": 1}}])]

    def drop(self, name):
        self.db[name].drop()


def run_against(uri: str, label: str) -> tuple[bool, str]:
    client = MongoClient(uri, serverSelectionTimeoutMS=120000)
    shared.wait_for(lambda: client.admin.command("ping"), "MongoDB")
    db = client["stack_vectors"]
    db.create_collection("probe")
    shared.wait_for(lambda: list(db["probe"].list_search_indexes()) is not None, "mongot (search service)", 240)
    db["probe"].drop()
    try:
        return shared.measure(Mongo(db), label)
    finally:
        client.drop_database("stack_vectors")
        client.close()


if __name__ == "__main__":
    results, notes = [], []
    try:
        shared.compose(HERE, "up", "-d")
        shared.wait_for(lambda: subprocess.run(["docker", "inspect", "-f", "{{.State.Health.Status}}", "stack-vector-dbs-mongodb-atlas"],
                                               capture_output=True, text=True).stdout.strip() == "healthy", "Atlas Local healthcheck", 300)
        ok, detail = run_against(f"mongodb://127.0.0.1:{PORT}/?directConnection=true", "atlas-local")
        results.append(ok)
        notes.append(f"atlas-local 8.0: {detail}")
    finally:
        shared.compose(HERE, "down", "-v")
    uri = config.env("MONGODB_URI")
    if uri:
        ok, detail = run_against(uri, "atlas-cloud")
        results.append(ok)
        notes.append(f"cloud: {detail}")
    else:
        notes.append("cloud not run, set MONGODB_URI to add it")
    checks.report("vector-dbs/mongodb-atlas", all(results), "; ".join(notes))
