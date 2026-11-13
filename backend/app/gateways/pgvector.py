"""PostgreSQL with pgvector: the lab's own vector database, in Docker on this machine (tools/vector-db.sh), or Azure
Database for PostgreSQL, which runs the same SQL.

Each chunk is a row: its text, the vector the embedding model made from it, and a full-text index of the same text, so
one database answers by meaning (cosine distance on an HNSW index), by words (Postgres full-text search) and by both
(reciprocal rank fusion of the two lists, in SQL). Vectors from different models cannot be compared, so the table is
chosen by vector length (chunks_768) and every row records the model that made it; searches match on both.

Who may read a chunk is enforced by PostgreSQL itself, with row-level security: each chunk has an access group, and a
search sets the reader's groups for its transaction (app.groups), so rows outside them are invisible to every query,
whatever the SQL says. The server's own connections are trusted and see everything (app.groups = '*'); a connection
that sets nothing sees nothing.

The SQL each search ran is returned with its results, so the page can show it.
"""
from __future__ import annotations

import re
import time
from typing import Any, Protocol
from urllib.parse import urlsplit

DISTANCE_INDEX = "hnsw"  # graph index: fast, approximate nearest neighbours, with no training step (unlike IVFFlat)
RRF_K = 60  # reciprocal rank fusion: score = 1/(60 + rank) per list, so a top place in either list counts


class VectorDbUnavailable(RuntimeError):
    """The database is not running, or does not have pgvector."""


class VectorStore(Protocol):
    def status(self) -> dict[str, Any]: ...
    def add(self, model: str, dims: int, collection: str, source: str, chunks: list[str],
            vectors: list[list[float]], access: str = "everyone", tags: list[str] | None = None) -> int: ...
    def sources(self, model: str, dims: int) -> list[dict[str, Any]]: ...
    def remove(self, model: str, dims: int, collection: str, source: str | None) -> int: ...
    def search(self, model: str, dims: int, collection: str, text: str, vector: list[float],
               k: int, groups: list[str] | None = None, tags: list[str] | None = None) -> dict[str, Any]: ...


def table(dims: int) -> str:
    """The table for vectors of this length. dims is checked as an int, so the name is safe to put in SQL."""
    if not isinstance(dims, int) or not 1 <= dims <= 4000:
        raise ValueError("A vector length must be between 1 and 4000 (the HNSW index's limit for vector).")
    return f"chunks_{dims}"


def literal(vector: list[float]) -> str:
    """pgvector's text form, '[0.1,0.2,...]', sent as a parameter and cast with ::vector."""
    return "[" + ",".join(f"{x:.7g}" for x in vector) + "]"


def create_sql(dims: int) -> str:
    t = table(dims)
    return f"""CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS {t} (
  id         bigserial PRIMARY KEY,
  model      text NOT NULL,          -- the embedding model that made the vector
  collection text NOT NULL,
  source     text NOT NULL,          -- the document the chunk came from
  chunk      int  NOT NULL,          -- its place in that document
  content    text NOT NULL,
  embedding  vector({dims}) NOT NULL,
  tsv        tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  added      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS {t}_embedding ON {t} USING {DISTANCE_INDEX} (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS {t}_tsv ON {t} USING gin (tsv);
CREATE INDEX IF NOT EXISTS {t}_scope ON {t} (model, collection, source);
-- Metadata: who may read each chunk, and labels to filter by.
ALTER TABLE {t} ADD COLUMN IF NOT EXISTS access text NOT NULL DEFAULT 'everyone';
ALTER TABLE {t} ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{{}}';
CREATE INDEX IF NOT EXISTS {t}_tags ON {t} USING gin (tags);
-- Row-level security: PostgreSQL hides every row outside the reader's groups, in every query. Searches run as
-- vector_reader, a role with no other rights; superusers always skip row-level security, so they must not search
-- as themselves. FORCE applies the policy to the table's owner too. Only a trusted connection ('*') may write.
DO $$ BEGIN CREATE ROLE vector_reader NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT vector_reader TO CURRENT_USER;
GRANT SELECT ON {t} TO vector_reader;
ALTER TABLE {t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS {t}_readers ON {t};
CREATE POLICY {t}_readers ON {t}
  USING (current_setting('app.groups', true) = '*'
         OR access = ANY (string_to_array(current_setting('app.groups', true), ',')))
  WITH CHECK (current_setting('app.groups', true) = '*');
-- websearch_to_tsquery joins the words with & (all of them); a search box wants any of them, ranked by how many.
CREATE OR REPLACE FUNCTION any_words(q text) RETURNS tsquery LANGUAGE sql IMMUTABLE AS
  $$ SELECT replace(websearch_to_tsquery('english', q)::text, ' & ', ' | ')::tsquery $$;"""


def semantic_sql(dims: int) -> str:
    t = table(dims)
    return f"""SELECT id, source, chunk, content, access, tags,
       1 - (embedding <=> %(vector)s::vector) AS similarity   -- <=> is cosine distance
FROM {t}
WHERE model = %(model)s AND collection = %(collection)s
  AND (%(tags)s::text[] IS NULL OR tags && %(tags)s::text[])  -- metadata filter: any of these tags
ORDER BY embedding <=> %(vector)s::vector                    -- answered from the HNSW index
LIMIT %(k)s"""


def keyword_sql(dims: int) -> str:
    t = table(dims)
    return f"""SELECT id, source, chunk, content, access, tags, ts_rank_cd(tsv, query) AS rank
FROM {t}, any_words(%(text)s) AS query
WHERE model = %(model)s AND collection = %(collection)s
  AND (%(tags)s::text[] IS NULL OR tags && %(tags)s::text[])
  AND tsv @@ query                                           -- answered from the GIN index
ORDER BY rank DESC
LIMIT %(k)s"""


def hybrid_sql(dims: int) -> str:
    t = table(dims)
    return f"""WITH semantic AS (
  SELECT id, row_number() OVER (ORDER BY embedding <=> %(vector)s::vector) AS place
  FROM {t}
  WHERE model = %(model)s AND collection = %(collection)s
    AND (%(tags)s::text[] IS NULL OR tags && %(tags)s::text[])
  ORDER BY embedding <=> %(vector)s::vector
  LIMIT %(pool)s
), keyword AS (
  SELECT id, row_number() OVER (ORDER BY ts_rank_cd(tsv, query) DESC) AS place
  FROM {t}, any_words(%(text)s) AS query
  WHERE model = %(model)s AND collection = %(collection)s AND tsv @@ query
    AND (%(tags)s::text[] IS NULL OR tags && %(tags)s::text[])
  ORDER BY ts_rank_cd(tsv, query) DESC
  LIMIT %(pool)s
)
SELECT c.id, c.source, c.chunk, c.content, c.access, c.tags,
       s.place AS semantic_place, k.place AS keyword_place,
       COALESCE(1.0 / ({RRF_K} + s.place), 0) + COALESCE(1.0 / ({RRF_K} + k.place), 0) AS score
FROM semantic s
FULL OUTER JOIN keyword k ON k.id = s.id
JOIN {t} c ON c.id = COALESCE(s.id, k.id)
ORDER BY score DESC
LIMIT %(k)s"""


def where(url: str) -> str:
    """host:port/database, without the user or password, for the page."""
    parts = urlsplit(url)
    return f"{parts.hostname or '?'}:{parts.port or 5432}{parts.path or ''}"


class PgVector:
    def __init__(self, url: str, connect_timeout_s: int = 3):
        self.url, self.connect_timeout_s = url, connect_timeout_s
        self._created: set[int] = set()

    def _connect(self) -> Any:
        if not self.url:
            raise VectorDbUnavailable("No database is set. Set LLM_LAB_PGVECTOR_URL, or run ./tools/vector-db.sh.")
        import psycopg  # imported here, so the backend starts without it until this page is used

        try:
            conn = psycopg.connect(self.url, connect_timeout=self.connect_timeout_s)
        except psycopg.OperationalError as exc:
            raise VectorDbUnavailable(f"PostgreSQL at {where(self.url)} did not answer. Start it with "
                                      "./tools/vector-db.sh (Docker Desktop must be running).") from exc
        # The server's own connection is trusted: it sees and writes every row. A search narrows this per transaction.
        conn.execute("SELECT set_config('app.groups', '*', false)")
        conn.commit()
        return conn

    def _ensure(self, conn: Any, dims: int) -> None:
        if dims in self._created:
            return
        import psycopg

        try:
            conn.execute(create_sql(dims))
        except psycopg.errors.FeatureNotSupported as exc:
            raise VectorDbUnavailable("This PostgreSQL has no pgvector extension. Use the pgvector/pgvector image "
                                      "(./tools/vector-db.sh), or allow VECTOR in Azure's azure.extensions.") from exc
        conn.commit()
        self._created.add(dims)

    def status(self) -> dict[str, Any]:
        """Whether the database answers, its pgvector version and what each table holds. Never raises."""
        info: dict[str, Any] = {"where": where(self.url) if self.url else "", "running": False}
        try:
            with self._connect() as conn:
                info["server"] = conn.execute("SHOW server_version").fetchone()[0]
                available = conn.execute(
                    "SELECT default_version FROM pg_available_extensions WHERE name = 'vector'").fetchone()
                installed = conn.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'").fetchone()
                info.update(running=True, pgvector=(installed or available or [None])[0], has_pgvector=bool(available))
                tables = conn.execute(
                    "SELECT table_name FROM information_schema.tables WHERE table_name ~ '^chunks_[0-9]+$'").fetchall()
                info["tables"] = []
                for (name,) in tables:
                    rows = conn.execute(f"SELECT count(*), pg_total_relation_size('{name}') FROM {name}").fetchone()
                    info["tables"].append({"name": name, "rows": rows[0], "bytes": rows[1]})
        except VectorDbUnavailable as exc:
            info["error"] = str(exc)
        except Exception as exc:  # status must not fail the page
            info["error"] = f"{type(exc).__name__}: {exc}"
        return info

    def add(self, model: str, dims: int, collection: str, source: str, chunks: list[str],
            vectors: list[list[float]], access: str = "everyone", tags: list[str] | None = None) -> int:
        """Stores a document's chunks, replacing any earlier copy of the same document, in one transaction."""
        t = table(dims)
        with self._connect() as conn:
            self._ensure(conn, dims)
            with conn.transaction():
                conn.execute(f"DELETE FROM {t} WHERE model = %s AND collection = %s AND source = %s",
                             (model, collection, source))
                with conn.cursor() as cur:
                    cur.executemany(
                        f"INSERT INTO {t} (model, collection, source, chunk, content, embedding, access, tags) "
                        "VALUES (%s, %s, %s, %s, %s, %s::vector, %s, %s)",
                        [(model, collection, source, i, c, literal(v), access, list(tags or []))
                         for i, (c, v) in enumerate(zip(chunks, vectors))])
        return len(chunks)

    def sources(self, model: str, dims: int) -> list[dict[str, Any]]:
        """Each document stored for this model: its collection, chunk count, characters and when it was added."""
        t = table(dims)
        with self._connect() as conn:
            self._ensure(conn, dims)
            rows = conn.execute(
                f"SELECT collection, source, count(*), sum(length(content)), max(added), max(access), "
                f"max(array_to_string(tags, ',')) FROM {t} WHERE model = %s "
                "GROUP BY collection, source ORDER BY collection, max(added) DESC", (model,)).fetchall()
        return [{"collection": c, "source": s, "chunks": n, "characters": chars, "added": added.isoformat(),
                 "access": access, "tags": [x for x in (tags or "").split(",") if x]}
                for c, s, n, chars, added, access, tags in rows]

    def remove(self, model: str, dims: int, collection: str, source: str | None) -> int:
        """Deletes one document, or the whole collection when source is None. Returns the rows deleted."""
        t = table(dims)
        with self._connect() as conn:
            self._ensure(conn, dims)
            if source is None:
                cur = conn.execute(f"DELETE FROM {t} WHERE model = %s AND collection = %s", (model, collection))
            else:
                cur = conn.execute(f"DELETE FROM {t} WHERE model = %s AND collection = %s AND source = %s",
                                   (model, collection, source))
            return cur.rowcount

    def search(self, model: str, dims: int, collection: str, text: str, vector: list[float],
               k: int, groups: list[str] | None = None, tags: list[str] | None = None) -> dict[str, Any]:
        """The top k chunks three ways (by meaning, by words, and both fused), each with its SQL and time, and the
        plan PostgreSQL chose for the search by meaning. With groups, the search runs as a reader in those groups:
        row-level security hides every other chunk, and the result says how many were hidden."""
        params = {"vector": literal(vector), "model": model, "collection": collection, "text": text, "k": k,
                  "pool": max(20, 4 * k), "tags": list(tags) if tags else None}
        out: dict[str, Any] = {}
        with self._connect() as conn:
            self._ensure(conn, dims)
            with conn.transaction():
                # pgvector 0.8: with a WHERE clause, keep walking the HNSW graph until k rows match, not just 40.
                # Older pgvector has no such setting: a savepoint keeps that failure from ending the transaction.
                try:
                    with conn.transaction():
                        conn.execute("SET LOCAL hnsw.iterative_scan = strict_order")
                except Exception:
                    pass
                count = f"SELECT count(*) FROM {table(dims)} WHERE model = %(model)s AND collection = %(collection)s"
                total = conn.execute(count, params).fetchone()[0]
                if groups is not None:
                    # From here to the end of the transaction, this connection reads as the user: an unprivileged
                    # role, so the policy applies, with the user's groups.
                    conn.execute("SET LOCAL ROLE vector_reader")
                    conn.execute("SELECT set_config('app.groups', %s, true)", (",".join(groups),))
                out["visible"] = conn.execute(count, params).fetchone()[0]
                out["hidden"] = total - out["visible"]
                for name, sql in (("semantic", semantic_sql(dims)), ("keyword", keyword_sql(dims)),
                                  ("hybrid", hybrid_sql(dims))):
                    started = time.perf_counter()
                    cur = conn.execute(sql, params)
                    columns = [d.name for d in cur.description]
                    rows = [dict(zip(columns, r)) for r in cur.fetchall()]
                    out[name] = {"sql": sql, "ms": round((time.perf_counter() - started) * 1000, 2),
                                 "rows": [{**r, "tags": list(r.get("tags") or []),
                                           **{c: float(r[c]) for c in ("similarity", "rank", "score") if c in r}}
                                          for r in rows]}
                plan = conn.execute("EXPLAIN " + semantic_sql(dims), params).fetchall()
                out["plan"] = re.sub(r"'\[[^\]]{40,}\]'", f"'[{dims} numbers]'", "\n".join(line for (line,) in plan))
        return out
