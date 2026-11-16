"""Chroma: the persistent client in a temporary folder, HNSW with cosine space, metadata filter with where=."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # vector-dbs
from common import checks, config  # noqa: E402
import shared  # noqa: E402

import shutil
import tempfile

import chromadb


class Chroma:
    def __init__(self, client):
        self.c = client

    def create(self, name, dim):
        self.c.create_collection(name, configuration={"hnsw": {"space": "cosine", "ef_construction": 100, "ef_search": 100, "max_neighbors": 16}})

    def insert(self, name, ids, vectors, metas):
        col = self.c.get_collection(name)
        md = [{"section": m["section"], "cid": m["id"]} for m in metas] if metas else None
        docs = [m["text"] for m in metas] if metas else None
        col.add(ids=[str(i) for i in ids], embeddings=vectors.tolist(), metadatas=md, documents=docs)

    def query(self, name, vector, k, section=None):
        res = self.c.get_collection(name).query(query_embeddings=[vector.tolist()], n_results=k,
                                                where={"section": section} if section else None)
        return [int(i) for i in res["ids"][0]]

    def drop(self, name):
        self.c.delete_collection(name)


if __name__ == "__main__":
    folder = tempfile.mkdtemp(prefix="stack-chroma-")
    try:
        client = chromadb.PersistentClient(path=folder)
        shared.run("chroma", Chroma(client), f"chromadb {chromadb.__version__}, persistent client")
    finally:
        shutil.rmtree(folder, ignore_errors=True)
