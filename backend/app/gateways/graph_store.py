"""The GraphRAG page's knowledge graph, kept in the same PostgreSQL as the vector database (pgvector).

Three tables per vector length, beside chunks_<dims>: the entities a model found in a collection's chunks (each with a
vector of its description, so a question can find the entities it is about), the relationships between them, and the
communities code found in the graph, each with a summary a model wrote. Rows record the embedding model and the
collection, as the chunks do. A graph walk is a recursive SQL query, so the page can show it.
"""
from __future__ import annotations

import json
from typing import Any, Protocol

from .pgvector import PgVector, VectorDbUnavailable, literal, table


class GraphStore(Protocol):
    def collections(self, model: str, dims: int) -> list[dict[str, Any]]: ...
    def chunks(self, model: str, dims: int, collection: str, limit: int) -> list[dict[str, Any]]: ...
    def chunk_texts(self, model: str, dims: int, collection: str, refs: list[tuple[str, int]]) -> list[dict[str, Any]]: ...
    def replace(self, model: str, dims: int, collection: str, entities: list[dict[str, Any]],
                relations: list[dict[str, Any]], communities: list[dict[str, Any]]) -> None: ...
    def graph(self, model: str, dims: int, collection: str) -> dict[str, Any]: ...
    def nearest(self, model: str, dims: int, collection: str, vector: list[float], k: int) -> list[dict[str, Any]]: ...
    def walk(self, model: str, dims: int, collection: str, seeds: list[str], hops: int,
             limit: int) -> dict[str, Any]: ...


def graph_tables(dims: int) -> tuple[str, str, str]:
    table(dims)  # checks dims is a sane int, so the names are safe in SQL
    return f"graph_entities_{dims}", f"graph_relations_{dims}", f"graph_communities_{dims}"


def create_sql(dims: int) -> str:
    e, r, c = graph_tables(dims)
    return f"""CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS {e} (
  id          bigserial PRIMARY KEY,
  model       text NOT NULL,       -- the embedding model that made the vector
  collection  text NOT NULL,
  key         text NOT NULL,       -- the normalised name: how duplicates are merged
  name        text NOT NULL,
  type        text NOT NULL,
  description text NOT NULL,
  refs        jsonb NOT NULL,      -- the chunks it was found in: [{{"source": ..., "chunk": n}}]
  degree      int NOT NULL,
  community   int NOT NULL,
  embedding   vector({dims}) NOT NULL,
  built       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model, collection, key)
);
CREATE INDEX IF NOT EXISTS {e}_embedding ON {e} USING hnsw (embedding vector_cosine_ops);
CREATE TABLE IF NOT EXISTS {r} (
  id          bigserial PRIMARY KEY,
  model       text NOT NULL,
  collection  text NOT NULL,
  source      text NOT NULL,       -- entity keys
  target      text NOT NULL,
  description text NOT NULL,
  strength    real NOT NULL,       -- 1 to 10, as the model judged it
  refs        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS {r}_source ON {r} (model, collection, source);
CREATE INDEX IF NOT EXISTS {r}_target ON {r} (model, collection, target);
CREATE TABLE IF NOT EXISTS {c} (
  id          bigserial PRIMARY KEY,
  model       text NOT NULL,
  collection  text NOT NULL,
  community   int NOT NULL,
  title       text NOT NULL,
  summary     text NOT NULL,
  members     jsonb NOT NULL,      -- entity keys
  UNIQUE (model, collection, community)
);"""


def walk_sql(dims: int) -> str:
    _, r, _ = graph_tables(dims)
    return f"""WITH RECURSIVE walk(key, hop) AS (
  SELECT unnest(%(seeds)s::text[]), 0                -- the entities nearest the question
  UNION
  SELECT CASE WHEN r.source = w.key THEN r.target ELSE r.source END, w.hop + 1
  FROM walk w
  JOIN {r} r ON w.key IN (r.source, r.target)        -- follow a relationship either way
  WHERE r.model = %(model)s AND r.collection = %(collection)s AND w.hop < %(hops)s
)
SELECT key, min(hop) AS hop FROM walk GROUP BY key"""


def relations_sql(dims: int) -> str:
    _, r, _ = graph_tables(dims)
    return f"""SELECT source, target, description, strength, refs
FROM {r}
WHERE model = %(model)s AND collection = %(collection)s
  AND source = ANY(%(reached)s) AND target = ANY(%(reached)s)
  AND (source = ANY(%(seeds)s) OR target = ANY(%(seeds)s) OR %(hops)s > 1)
ORDER BY (source = ANY(%(seeds)s) OR target = ANY(%(seeds)s)) DESC, strength DESC
LIMIT %(limit)s"""


def nearest_sql(dims: int) -> str:
    e, _, _ = graph_tables(dims)
    return f"""SELECT key, name, type, description, refs, community,
       1 - (embedding <=> %(vector)s::vector) AS similarity
FROM {e}
WHERE model = %(model)s AND collection = %(collection)s
ORDER BY embedding <=> %(vector)s::vector
LIMIT %(k)s"""


class PgGraph:
    """The graph tables, through the vector database's connection."""

    def __init__(self, db: PgVector):
        self.db = db
        self._created: set[int] = set()

    def _conn(self, dims: int) -> Any:
        conn = self.db._connect()
        if dims not in self._created:
            import psycopg

            try:
                conn.execute(create_sql(dims))
            except psycopg.errors.FeatureNotSupported as exc:
                conn.close()
                raise VectorDbUnavailable("This PostgreSQL has no pgvector extension. Use ./tools/vector-db.sh.") from exc
            conn.commit()
            self._created.add(dims)
        return conn

    def collections(self, model: str, dims: int) -> list[dict[str, Any]]:
        """Each collection with chunks for this model, and what its graph holds, if one is built."""
        e, r, c = graph_tables(dims)
        chunks = table(dims)
        with self._conn(dims) as conn:
            if not conn.execute("SELECT to_regclass(%s)", (chunks,)).fetchone()[0]:
                return []
            rows = conn.execute(f"""
SELECT ch.collection, count(*) AS chunks, count(DISTINCT ch.source) AS documents,
       (SELECT count(*) FROM {e} WHERE model = %(m)s AND collection = ch.collection) AS entities,
       (SELECT count(*) FROM {r} WHERE model = %(m)s AND collection = ch.collection) AS relations,
       (SELECT count(*) FROM {c} WHERE model = %(m)s AND collection = ch.collection) AS communities,
       (SELECT max(built) FROM {e} WHERE model = %(m)s AND collection = ch.collection) AS built
FROM {chunks} ch WHERE ch.model = %(m)s GROUP BY ch.collection ORDER BY ch.collection""", {"m": model}).fetchall()
        return [{"collection": col, "chunks": n, "documents": docs, "entities": ents, "relations": rels,
                 "communities": comms, "built": built.isoformat() if built else None}
                for col, n, docs, ents, rels, comms, built in rows]

    def chunks(self, model: str, dims: int, collection: str, limit: int) -> list[dict[str, Any]]:
        with self._conn(dims) as conn:
            rows = conn.execute(f"SELECT source, chunk, content FROM {table(dims)} WHERE model = %s AND collection = %s "
                                "ORDER BY source, chunk LIMIT %s", (model, collection, limit)).fetchall()
        return [{"source": s, "chunk": n, "content": t} for s, n, t in rows]

    def chunk_texts(self, model: str, dims: int, collection: str, refs: list[tuple[str, int]]) -> list[dict[str, Any]]:
        if not refs:
            return []
        with self._conn(dims) as conn:
            rows = conn.execute(
                f"SELECT source, chunk, content FROM {table(dims)} WHERE model = %s AND collection = %s "
                "AND (source, chunk) IN (SELECT * FROM unnest(%s::text[], %s::int[]))",
                (model, collection, [s for s, _ in refs], [n for _, n in refs])).fetchall()
        found = {(s, n): t for s, n, t in rows}
        return [{"source": s, "chunk": n, "content": found[(s, n)]} for s, n in refs if (s, n) in found]

    def replace(self, model: str, dims: int, collection: str, entities: list[dict[str, Any]],
                relations: list[dict[str, Any]], communities: list[dict[str, Any]]) -> None:
        """Swaps a collection's graph for a new one in one transaction, so a search never sees half a graph."""
        e, r, c = graph_tables(dims)
        with self._conn(dims) as conn, conn.transaction():
            for t in (e, r, c):
                conn.execute(f"DELETE FROM {t} WHERE model = %s AND collection = %s", (model, collection))
            with conn.cursor() as cur:
                cur.executemany(
                    f"INSERT INTO {e} (model, collection, key, name, type, description, refs, degree, community, "
                    "embedding) VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s::vector)",
                    [(model, collection, x["key"], x["name"], x["type"], x["description"], json.dumps(x["refs"]),
                      x["degree"], x["community"], literal(x["vector"])) for x in entities])
                cur.executemany(
                    f"INSERT INTO {r} (model, collection, source, target, description, strength, refs) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)",
                    [(model, collection, x["source"], x["target"], x["description"], x["strength"],
                      json.dumps(x["refs"])) for x in relations])
                cur.executemany(
                    f"INSERT INTO {c} (model, collection, community, title, summary, members) "
                    "VALUES (%s, %s, %s, %s, %s, %s::jsonb)",
                    [(model, collection, x["community"], x["title"], x["summary"], json.dumps(x["members"]))
                     for x in communities])

    def graph(self, model: str, dims: int, collection: str) -> dict[str, Any]:
        e, r, c = graph_tables(dims)
        with self._conn(dims) as conn:
            ents = conn.execute(f"SELECT key, name, type, description, refs, degree, community FROM {e} "
                                "WHERE model = %s AND collection = %s ORDER BY degree DESC, key",
                                (model, collection)).fetchall()
            rels = conn.execute(f"SELECT source, target, description, strength FROM {r} "
                                "WHERE model = %s AND collection = %s ORDER BY strength DESC",
                                (model, collection)).fetchall()
            comms = conn.execute(f"SELECT community, title, summary, members FROM {c} "
                                 "WHERE model = %s AND collection = %s ORDER BY community",
                                 (model, collection)).fetchall()
        return {
            "entities": [{"key": k, "name": n, "type": t, "description": d, "refs": refs, "degree": deg,
                          "community": com} for k, n, t, d, refs, deg, com in ents],
            "relations": [{"source": s, "target": t, "description": d, "strength": float(w)} for s, t, d, w in rels],
            "communities": [{"community": n, "title": t, "summary": s, "members": m} for n, t, s, m in comms],
        }

    def nearest(self, model: str, dims: int, collection: str, vector: list[float], k: int) -> list[dict[str, Any]]:
        with self._conn(dims) as conn:
            cur = conn.execute(nearest_sql(dims), {"vector": literal(vector), "model": model,
                                                   "collection": collection, "k": k})
            cols = [d.name for d in cur.description]
            return [{**dict(zip(cols, row)), "similarity": float(row[-1])} for row in cur.fetchall()]

    def walk(self, model: str, dims: int, collection: str, seeds: list[str], hops: int, limit: int) -> dict[str, Any]:
        """The entities within `hops` relationships of the seeds, and the strongest relationships among them."""
        params = {"seeds": seeds, "model": model, "collection": collection, "hops": hops, "limit": limit}
        with self._conn(dims) as conn:
            reached = {k: h for k, h in conn.execute(walk_sql(dims), params).fetchall()}
            cur = conn.execute(relations_sql(dims), {**params, "reached": list(reached)})
            rels = [{"source": s, "target": t, "description": d, "strength": float(w), "refs": refs}
                    for s, t, d, w, refs in cur.fetchall()]
        return {"reached": reached, "relations": rels}
