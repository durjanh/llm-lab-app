"""Chroma as a memory store: facts with metadata (user_id, session, superseded), recalled by similarity.

Chroma only stores and searches. Claude decides what to remember and which old memory a new message replaces
(`shared.extract`); the superseded flag then keeps the stale £600 out of recall.
"""
import sys
import tempfile
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/memory
import shared  # noqa: E402
from common import checks, config  # noqa: E402

NAME = "memory/chroma"
if not config.HAS_CLAUDE:
    checks.skip(NAME, "set ANTHROPIC_API_KEY in the lab's .env")
    sys.exit(0)

import chromadb  # noqa: E402


class FastEmbed(chromadb.EmbeddingFunction):
    """Chroma's embedding hook, backed by the shared local BGE embedder."""

    def __init__(self):
        pass

    def __call__(self, input):
        return shared.embed(list(input))

    @staticmethod
    def name():
        return "stack-fastembed-bge"


with tempfile.TemporaryDirectory(prefix="stack-chroma-") as folder:
    client = chromadb.PersistentClient(path=folder)  # in process, written to a temp folder
    memories = client.create_collection("memories", embedding_function=FastEmbed(), configuration={"hnsw": {"space": "cosine"}})

    # Session 1: Claude extracts facts turn by turn; corrections flip `superseded` on the old row.
    for user_msg, _ in shared.SESSION_1_TURNS:
        stored = memories.get(where={"$and": [{"user_id": shared.USER_ID}, {"superseded": False}]})
        out = shared.extract(user_msg, list(zip(stored["ids"], stored["documents"])))
        for old in out["supersede"]:
            if old in stored["ids"]:
                memories.update(ids=[old], metadatas=[{"superseded": True}])
        for fact in out["add"]:
            memories.add(ids=[uuid.uuid4().hex[:8]], documents=[fact],
                         metadatas=[{"user_id": shared.USER_ID, "session": shared.SESSION_1, "superseded": False}])
    everything = memories.get()
    live = sum(1 for m in everything["metadatas"] if not m["superseded"])
    print(f"stored {len(everything['ids'])} memories, {live} current:")
    for doc, meta in zip(everything["documents"], everything["metadatas"]):
        print(f"  {'(superseded) ' if meta['superseded'] else ''}{doc}")

    def recall(question: str) -> list[str]:
        hits = memories.query(query_texts=[question], n_results=3,
                              where={"$and": [{"user_id": shared.USER_ID}, {"superseded": False}]})
        return hits["documents"][0]

    # Session 2: a new conversation, same user id, no history.
    shared.evaluate(NAME, recall, f"{live} current of {len(everything['ids'])} stored")
