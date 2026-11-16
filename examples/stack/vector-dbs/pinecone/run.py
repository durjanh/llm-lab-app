"""Pinecone: the official Pinecone Local emulator in Docker, with the Pinecone SDK. If PINECONE_API_KEY is set, the
same benchmark also runs against Pinecone's cloud (a serverless index, deleted afterwards)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # vector-dbs
from common import checks, config  # noqa: E402
import shared  # noqa: E402

from pinecone import Pinecone, ServerlessSpec

HERE = Path(__file__).resolve().parent
PORT = config.PORTS["vector-dbs"][0] + 10  # 18710; each index the emulator makes takes the next port


def index_name(name: str) -> str:
    return name.replace("_", "-")  # index names allow lowercase letters, digits and hyphens


class Pine:
    def __init__(self, pc, local: bool):
        self.pc, self.local, self.idx, self.count = pc, local, {}, {}

    def create(self, name, dim):
        n = index_name(name)
        self.pc.create_index(name=n, dimension=dim, metric="cosine", spec=ServerlessSpec(cloud="aws", region="us-east-1"))
        shared.wait_for(lambda: self.pc.describe_index(n).status["ready"], "Pinecone index", 300)
        host = self.pc.describe_index(n).host
        self.idx[n] = self.pc.Index(host=("http://" + host) if self.local and "://" not in host else host)
        self.count[n] = 0

    def insert(self, name, ids, vectors, metas):
        n = index_name(name)
        metas = metas or [None] * len(ids)
        for a in range(0, len(ids), 200):  # a request is limited to 2 MB
            self.idx[n].upsert(vectors=[
                {"id": str(i), "values": v.tolist(), **({"metadata": {"section": m["section"], "cid": m["id"]}} if m else {})}
                for i, v, m in zip(ids[a:a + 200], vectors[a:a + 200], metas[a:a + 200])])
        self.count[n] += len(ids)

    def flush(self, name):  # upserts are eventually consistent: wait until every row is counted
        n = index_name(name)
        shared.wait_for(lambda: self.idx[n].describe_index_stats().total_vector_count >= self.count[n], "Pinecone rows", 300)

    def query(self, name, vector, k, section=None):
        res = self.idx[index_name(name)].query(vector=vector.tolist(), top_k=k,
                                               filter={"section": {"$eq": section}} if section else None)
        return [int(m.id) for m in res.matches]

    def drop(self, name):
        self.pc.delete_index(index_name(name))


if __name__ == "__main__":
    key = config.env("PINECONE_API_KEY")
    results, notes = [], []
    try:
        shared.compose(HERE, "up", "-d")
        url = f"http://127.0.0.1:{PORT}"
        shared.wait_for(lambda: Pinecone(api_key="pclocal", host=url).list_indexes() is not None, "Pinecone Local")
        ok, detail = shared.measure(Pine(Pinecone(api_key="pclocal", host=url), True), "emulator")
        results.append(ok)
        notes.append(f"emulator (amd64 image, emulated): {detail}")
    finally:
        shared.compose(HERE, "down", "-v")
    if key:
        ok, detail = shared.measure(Pine(Pinecone(api_key=key), False), "cloud")
        results.append(ok)
        notes.append(f"cloud: {detail}")
    else:
        notes.append("cloud not run, set PINECONE_API_KEY to add it")
    checks.report("vector-dbs/pinecone", all(results), "; ".join(notes))
