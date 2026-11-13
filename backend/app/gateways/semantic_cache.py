"""A semantic cache in PostgreSQL with pgvector: questions already answered, kept with their answers and the vector of
the question, so a new question close enough in meaning gets the stored answer without a model call.

Entries are scoped: the same question can have different right answers for a different answering model, system prompt
or user, so a lookup only matches entries with the same scope. Each entry expires after a time to live.
"""
from __future__ import annotations

from typing import Any, Protocol

from .pgvector import PgVector, literal, table


class CacheStore(Protocol):
    def status(self) -> dict[str, Any]: ...
    def nearest(self, dims: int, embed_model: str, scope: str, vector: list[float], k: int,
                ttl_s: int) -> list[dict[str, Any]]: ...
    def put(self, dims: int, embed_model: str, scope: str, question: str, answer: str, vector: list[float],
            cost_usd: float, ms: float) -> int: ...
    def hit(self, dims: int, entry_id: int) -> None: ...
    def entries(self, dims: int, embed_model: str, scope: str | None) -> list[dict[str, Any]]: ...
    def clear(self, dims: int, embed_model: str) -> int: ...


def cache_table(dims: int) -> str:
    return "semcache_" + table(dims).split("_", 1)[1]


def create_cache_sql(dims: int) -> str:
    t = cache_table(dims)
    return f"""CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS {t} (
  id          bigserial PRIMARY KEY,
  embed_model text NOT NULL,         -- the model that made the vector
  scope       text NOT NULL,         -- answering model + prompt version + user: who may reuse this answer
  question    text NOT NULL,
  answer      text NOT NULL,
  embedding   vector({dims}) NOT NULL,
  cost_usd    numeric NOT NULL,      -- what the answer cost when it was made, saved again on every hit
  ms          numeric NOT NULL,      -- how long it took
  hits        int NOT NULL DEFAULT 0,
  created     timestamptz NOT NULL DEFAULT now(),
  last_hit    timestamptz
);
CREATE INDEX IF NOT EXISTS {t}_embedding ON {t} USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS {t}_scope ON {t} (embed_model, scope);"""


def lookup_sql(dims: int) -> str:
    t = cache_table(dims)
    return f"""SELECT id, question, answer, cost_usd, ms, hits,
       1 - (embedding <=> %(vector)s::vector) AS similarity
FROM {t}
WHERE embed_model = %(embed_model)s AND scope = %(scope)s
  AND created > now() - make_interval(secs => %(ttl_s)s)    -- older entries have expired
ORDER BY embedding <=> %(vector)s::vector
LIMIT %(k)s"""


class PgSemanticCache:
    def __init__(self, url: str):
        self.db = PgVector(url)
        self._created: set[int] = set()

    def _conn(self, dims: int) -> Any:
        conn = self.db._connect()
        if dims not in self._created:
            conn.execute(create_cache_sql(dims))
            conn.commit()
            self._created.add(dims)
        return conn

    def status(self) -> dict[str, Any]:
        return self.db.status()

    def nearest(self, dims: int, embed_model: str, scope: str, vector: list[float], k: int,
                ttl_s: int) -> list[dict[str, Any]]:
        with self._conn(dims) as conn:
            cur = conn.execute(lookup_sql(dims), {"vector": literal(vector), "embed_model": embed_model,
                                                  "scope": scope, "k": k, "ttl_s": ttl_s})
            columns = [d.name for d in cur.description]
            rows = [dict(zip(columns, r)) for r in cur.fetchall()]
        return [{**r, "similarity": float(r["similarity"]), "cost_usd": float(r["cost_usd"]), "ms": float(r["ms"])}
                for r in rows]

    def put(self, dims: int, embed_model: str, scope: str, question: str, answer: str, vector: list[float],
            cost_usd: float, ms: float) -> int:
        with self._conn(dims) as conn:
            return conn.execute(
                f"INSERT INTO {cache_table(dims)} (embed_model, scope, question, answer, embedding, cost_usd, ms) "
                "VALUES (%s, %s, %s, %s, %s::vector, %s, %s) RETURNING id",
                (embed_model, scope, question, answer, literal(vector), cost_usd, ms)).fetchone()[0]

    def hit(self, dims: int, entry_id: int) -> None:
        with self._conn(dims) as conn:
            conn.execute(f"UPDATE {cache_table(dims)} SET hits = hits + 1, last_hit = now() WHERE id = %s", (entry_id,))

    def entries(self, dims: int, embed_model: str, scope: str | None) -> list[dict[str, Any]]:
        with self._conn(dims) as conn:
            rows = conn.execute(
                f"SELECT id, scope, question, answer, cost_usd, ms, hits, created FROM {cache_table(dims)} "
                "WHERE embed_model = %s AND (%s::text IS NULL OR scope = %s) ORDER BY created DESC LIMIT 200",
                (embed_model, scope, scope)).fetchall()
        return [{"id": i, "scope": s, "question": q, "answer": a, "cost_usd": float(c), "ms": float(m), "hits": h,
                 "created": created.isoformat()} for i, s, q, a, c, m, h, created in rows]

    def clear(self, dims: int, embed_model: str) -> int:
        with self._conn(dims) as conn:
            return conn.execute(f"DELETE FROM {cache_table(dims)} WHERE embed_model = %s", (embed_model,)).rowcount
