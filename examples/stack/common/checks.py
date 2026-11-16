"""The one result line every example prints last, which run_all.py reads.

    PASS rag/haystack: 12/12 answers correct
    SKIP vector-dbs/pinecone: set PINECONE_API_KEY to run against Pinecone's cloud
    FAIL memory/mem0: recalled 1 of 3 facts
"""
from __future__ import annotations

import time

_start = time.time()


def report(name: str, ok: bool, detail: str = "") -> bool:
    """Print PASS or FAIL for "area/tool" with a short detail."""
    print(f"\n{'PASS' if ok else 'FAIL'} {name} ({time.time() - _start:.1f}s){': ' + detail if detail else ''}", flush=True)
    return ok


def skip(name: str, why: str) -> None:
    """Print SKIP with what is needed to run it (an account, a key, a GPU). Use it instead of failing."""
    print(f"\nSKIP {name}: {why}", flush=True)


def score(results: list[bool]) -> str:
    return f"{sum(results)}/{len(results)}"
