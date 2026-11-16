"""Elasticsearch single node in Docker: dense_vector with an HNSW index, knn search with a filter, and a hybrid query
(BM25 on the text plus kNN on the vector), which is the usual reason to choose it."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # vector-dbs
from common import checks, config  # noqa: E402
import shared  # noqa: E402

import numpy as np
from elasticsearch import Elasticsearch, helpers

HERE = Path(__file__).resolve().parent
PORT = config.PORTS["vector-dbs"][0] + 70  # 18770


class Es:
    def __init__(self, es):
        self.es = es

    def create(self, name, dim):
        self.es.indices.create(index=name, settings={"number_of_shards": 1, "number_of_replicas": 0, "refresh_interval": "-1"}, mappings={"properties": {
            "vector": {"type": "dense_vector", "dims": dim, "index": True, "similarity": "cosine",
                       "index_options": {"type": "hnsw", "m": 16, "ef_construction": 100}},
            "section": {"type": "keyword"}, "cid": {"type": "keyword"}, "text": {"type": "text"}}})

    def insert(self, name, ids, vectors, metas):
        actions = ({"_index": name, "_id": str(i), "vector": v.tolist(), **({"section": m["section"], "cid": m["id"], "text": m["text"]} if m else {})}
                   for i, v, m in zip(ids, vectors, metas or [None] * len(ids)))
        helpers.bulk(self.es, actions)

    def flush(self, name):
        self.es.indices.refresh(index=name)  # makes the rows searchable (refresh is off during the load)

    def query(self, name, vector, k, section=None):
        knn = {"field": "vector", "query_vector": vector.tolist(), "k": k, "num_candidates": 200}
        if section:
            knn["filter"] = {"term": {"section": section}}
        res = self.es.search(index=name, knn=knn, size=k, source=False)
        return [int(h["_id"]) for h in res["hits"]["hits"]]

    def drop(self, name):
        self.es.indices.delete(index=name)


def hybrid_demo(es: Elasticsearch) -> bool:
    """One request that mixes BM25 (the exact words) with kNN (the meaning); the scores are added. RRF needs a paid licence, so it is not used."""
    chunks, cv, qv = shared.load()
    store = Es(es)
    store.create("stack_hybrid", shared.DIM)
    store.insert("stack_hybrid", list(range(len(chunks))), cv, chunks)
    store.flush("stack_hybrid")
    gold = next(i for i, g in enumerate(shared.data.GOLD) if g.section == "Information security")
    res = es.search(index="stack_hybrid", size=3, source=["section"],
                    query={"match": {"text": {"query": "report phishing button", "boost": 0.5}}},
                    knn={"field": "vector", "query_vector": qv[gold].tolist(), "k": 10, "num_candidates": 50, "boost": 1.0})
    sections = [h["_source"]["section"] for h in res["hits"]["hits"]]
    print("hybrid (BM25 + kNN, scores added): top 3 sections", sections)
    es.indices.delete(index="stack_hybrid")
    return sections[0] == "Information security"


if __name__ == "__main__":
    try:
        shared.compose(HERE, "up", "-d")
        es = Elasticsearch(f"http://127.0.0.1:{PORT}", request_timeout=120)
        shared.wait_for(lambda: es.info(), "Elasticsearch", 240)
        version = es.info()["version"]["number"]
        ok, detail = shared.measure(Es(es))
        hybrid = hybrid_demo(es)
        checks.report("vector-dbs/elasticsearch", ok and hybrid, f"{detail}, hybrid {'ok' if hybrid else 'WRONG'} (Elasticsearch {version}, heap 768m)")
    finally:
        shared.compose(HERE, "down", "-v")
