"""pgvector baseline: the lab's own PostgreSQL container, a separate database stack_vectors, HNSW cosine index."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # vector-dbs
from common import checks  # noqa: E402
import shared  # noqa: E402

import numpy as np
import psycopg
from pgvector.psycopg import register_vector

ADMIN = "postgresql://lab:lab@127.0.0.1:5433/postgres"
URL = "postgresql://lab:lab@127.0.0.1:5433/stack_vectors"


class Pg:
    def __init__(self):
        with psycopg.connect(ADMIN, autocommit=True) as c:
            c.execute("DROP DATABASE IF EXISTS stack_vectors")
            c.execute("CREATE DATABASE stack_vectors")
        with psycopg.connect(URL, autocommit=True) as c:
            c.execute("CREATE EXTENSION IF NOT EXISTS vector")
        self.c = psycopg.connect(URL, autocommit=True)
        register_vector(self.c)

    def create(self, name, dim):
        self.c.execute(f"CREATE TABLE {name} (id int PRIMARY KEY, section text, cid text, content text, embedding vector({dim}))")
        # The index is made up front, as the lab does, so inserts pay for it.
        self.c.execute(f"CREATE INDEX ON {name} USING hnsw (embedding vector_cosine_ops)")

    def insert(self, name, ids, vectors, metas):
        rows = [(i, m["section"] if metas else None, m["id"] if metas else None, m["text"] if metas else None, v)
                for i, v, m in zip(ids, vectors, metas or [None] * len(ids))]
        with self.c.cursor() as cur:  # COPY is the fast way in
            with cur.copy(f"COPY {name} (id, section, cid, content, embedding) FROM STDIN (FORMAT BINARY)") as copy:
                copy.set_types(["int4", "text", "text", "text", "vector"])
                for r in rows:
                    copy.write_row(r)

    def query(self, name, vector, k, section=None):
        self.c.execute("SET hnsw.ef_search = 100")
        where, args = ("WHERE section = %s ", [section]) if section else ("", [])
        sql = f"SELECT id FROM {name} {where}ORDER BY embedding <=> %s LIMIT {k}"
        return [r[0] for r in self.c.execute(sql, [*args, vector]).fetchall()]

    def drop(self, name):
        self.c.execute(f"DROP TABLE {name}")  # drops its HNSW index with it

    def close(self):
        self.c.close()
        with psycopg.connect(ADMIN, autocommit=True) as c:
            c.execute("DROP DATABASE IF EXISTS stack_vectors")


if __name__ == "__main__":
    try:
        psycopg.connect(ADMIN, connect_timeout=3).close()
    except Exception as e:
        checks.skip("vector-dbs/pgvector", f"start the lab's database first (tools/vector-db.sh): {type(e).__name__}")
        raise SystemExit
    store = Pg()
    try:
        shared.run("pgvector", store, "HNSW m=16 ef_construction=64 ef_search=100")
    finally:
        store.close()
