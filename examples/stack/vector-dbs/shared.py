"""The benchmark every vector database runs, so the tools compare line for line.

Needs numpy (every tool's requirements include it). Three parts:

  1. Correctness: the handbook chunks and the 12 gold questions, embedded once with local BGE small (384 dimensions)
     and cached in .cache/, so every database searches identical vectors. The gold section must be in the top 3 for
     at least 11 of 12 questions.
  2. Metadata filter: the same search limited to chunks from the "Expenses" section.
  3. Scale: 20,000 clustered unit vectors (fixed seed) inserted in batches, then 200 queries. Reports insert time,
     p50/p95 query latency and recall@10 against brute-force cosine.

A tool writes a small adapter (the `Store` protocol below) and calls `run(tool, store)`, which prints the numbers and
the final PASS/FAIL line. Ids are integers: chunk i is row i of the cached chunk list.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any, Protocol

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack
from common import checks, config, data  # noqa: E402

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
DIM = 384
SCALE_N, SCALE_QUERIES, SCALE_BATCH, SEED = 20_000, 200, 1_000, 42
FILTER_SECTION = "Expenses"
SMALL, BIG = "stack_small", "stack_scale"  # collection names every tool uses


class Store(Protocol):
    """What a tool provides. Vectors are unit length, so cosine, dot product and L2 give the same order."""

    def create(self, name: str, dim: int) -> None:
        """Make an empty collection with a cosine (or equivalent) HNSW index."""

    def insert(self, name: str, ids: list[int], vectors: np.ndarray, metas: list[dict[str, Any]] | None) -> None:
        """Add rows. metas (small collection only) has {"id": "annual-leave-0", "section": "Annual leave", "text": ...}."""

    def query(self, name: str, vector: np.ndarray, k: int, section: str | None = None) -> list[int]:
        """Return the ids of the k nearest rows, best first, limited to one section when given."""

    def drop(self, name: str) -> None: ...

    # Optional: flush(name), called after the last insert (counted in the insert time) for stores that need it.


# ---- the cached vectors ----

def build_cache() -> None:
    """Embed the chunks and questions with BGE small (fastembed, ONNX, no key) and save them. Run once."""
    from fastembed import TextEmbedding

    model = TextEmbedding(config.LOCAL_EMBEDDING)
    chunks = data.chunks()
    # BGE's retrieval prefix goes on the questions only.
    prefix = "Represent this sentence for searching relevant passages: "
    cv = np.array(list(model.embed([c.text for c in chunks])), dtype=np.float32)
    qv = np.array(list(model.embed([prefix + g.question for g in data.GOLD])), dtype=np.float32)
    cv /= np.linalg.norm(cv, axis=1, keepdims=True)
    qv /= np.linalg.norm(qv, axis=1, keepdims=True)
    CACHE.mkdir(exist_ok=True)
    np.save(CACHE / "chunk_vectors.npy", cv)
    np.save(CACHE / "question_vectors.npy", qv)
    (CACHE / "meta.json").write_text(json.dumps({
        "model": config.LOCAL_EMBEDDING, "dim": int(cv.shape[1]),
        "chunks": [{"id": c.id, "section": c.section, "text": c.text} for c in chunks],
        "questions": [{"question": g.question, "section": g.section} for g in data.GOLD]}, indent=1))


def load() -> tuple[list[dict[str, Any]], np.ndarray, np.ndarray]:
    """(chunk metadata, chunk vectors, question vectors), built on first use if fastembed is installed."""
    if not (CACHE / "meta.json").exists():
        build_cache()
    meta = json.loads((CACHE / "meta.json").read_text())
    return meta["chunks"], np.load(CACHE / "chunk_vectors.npy"), np.load(CACHE / "question_vectors.npy")


def brute_force(vectors: np.ndarray, query: np.ndarray, k: int, mask: np.ndarray | None = None) -> list[int]:
    scores = vectors @ query
    if mask is not None:
        scores = np.where(mask, scores, -np.inf)
    return [int(i) for i in np.argsort(-scores)[:k]]


# ---- the three checks ----

def correctness(store: Store) -> tuple[int, int, int, bool]:
    """(gold hits in top 3, matches with brute force, total, filter ok)."""
    chunks, cv, qv = load()
    store.create(SMALL, DIM)
    store.insert(SMALL, list(range(len(chunks))), cv, chunks)
    getattr(store, "flush", lambda name: None)(SMALL)
    hits = same = 0
    for g, q in zip(data.GOLD, qv):
        top = store.query(SMALL, q, 3)
        hits += g.section in {chunks[i]["section"] for i in top}
        same += set(top) == set(brute_force(cv, q, 3))
    mask = np.array([c["section"] == FILTER_SECTION for c in chunks])
    filter_ok = True
    for q in qv[:6]:
        got = store.query(SMALL, q, 3, section=FILTER_SECTION)
        filter_ok &= bool(got) and all(chunks[i]["section"] == FILTER_SECTION for i in got)
        filter_ok &= set(got) == set(brute_force(cv, q, 3, mask))
    store.drop(SMALL)
    return hits, same, len(data.GOLD), filter_ok


def scale_vectors() -> tuple[np.ndarray, np.ndarray]:
    """20,000 base vectors and 200 queries: 100 random cluster centres plus noise, normalised (fixed seed).

    Pure uniform noise in 384 dimensions has no neighbours worth finding (every distance is about the same), so every
    graph index scores badly on it. Clusters give the structure real embeddings have, and stay fully reproducible.
    """
    rng = np.random.default_rng(SEED)
    centres = rng.standard_normal((100, DIM)).astype(np.float32)
    pick = rng.integers(0, 100, SCALE_N + SCALE_QUERIES)
    v = centres[pick] + 0.7 * rng.standard_normal((SCALE_N + SCALE_QUERIES, DIM)).astype(np.float32)
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    return v[:SCALE_N], v[SCALE_N:]


def scale(store: Store) -> dict[str, float]:
    base, queries = scale_vectors()
    store.create(BIG, DIM)
    start = time.perf_counter()
    for i in range(0, SCALE_N, SCALE_BATCH):
        store.insert(BIG, list(range(i, i + SCALE_BATCH)), base[i:i + SCALE_BATCH], None)
    getattr(store, "flush", lambda name: None)(BIG)
    insert_s = time.perf_counter() - start
    for q in queries[:5]:  # warm up
        store.query(BIG, q, 10)
    times, recalls = [], []
    for q in queries:
        t = time.perf_counter()
        got = store.query(BIG, q, 10)
        times.append((time.perf_counter() - t) * 1000)
        recalls.append(len(set(got) & set(brute_force(base, q, 10))) / 10)
    store.drop(BIG)
    return {"insert_s": insert_s, "p50_ms": float(np.percentile(times, 50)),
            "p95_ms": float(np.percentile(times, 95)), "recall": float(np.mean(recalls))}


def measure(store: Store, label: str = "") -> tuple[bool, str]:
    """Run all three checks, print the numbers, and return (ok, one-line detail)."""
    hits, same, total, filter_ok = correctness(store)
    tag = f"[{label}] " if label else ""
    print(f"{tag}correctness: gold section in top 3 for {hits}/{total}; same top 3 as brute force for {same}/{total}")
    print(f"{tag}filter: only '{FILTER_SECTION}' chunks, matching brute force: {'yes' if filter_ok else 'NO'}")
    s = scale(store)
    print(f"{tag}scale: {SCALE_N} vectors in {s['insert_s']:.1f}s; p50 {s['p50_ms']:.1f} ms, p95 {s['p95_ms']:.1f} ms, "
          f"recall@10 {s['recall']:.3f} over {SCALE_QUERIES} queries", flush=True)
    ok = hits >= 11 and filter_ok and s["recall"] >= 0.8
    return ok, (f"gold {hits}/{total}, filter {'ok' if filter_ok else 'WRONG'}, insert {s['insert_s']:.1f}s, "
                f"p50 {s['p50_ms']:.1f}ms, p95 {s['p95_ms']:.1f}ms, recall@10 {s['recall']:.3f}")


def run(tool: str, store: Store, note: str = "") -> bool:
    """measure(), then print PASS or FAIL for vector-dbs/<tool>."""
    ok, detail = measure(store)
    return checks.report(f"vector-dbs/{tool}", ok, detail + (f" ({note})" if note else ""))


# ---- helpers for tools that run a server in Docker ----

def compose(folder: Path, *args: str) -> None:
    """docker compose in a tool's folder (its docker-compose.yml names the container stack-vector-dbs-<tool>)."""
    import subprocess
    subprocess.run(["docker", "compose", *args], cwd=folder, check=True)


def wait_for(ready, what: str, seconds: int = 180) -> None:
    """Call ready() until it stops raising and returns truthy, or fail after the time is up."""
    end, last = time.time() + seconds, None
    while time.time() < end:
        try:
            if ready():
                return
        except Exception as e:  # the server is still starting
            last = e
        time.sleep(2)
    raise RuntimeError(f"{what} did not become ready in {seconds}s ({last})")


if __name__ == "__main__":
    build_cache()
    print("cache built in", CACHE)
