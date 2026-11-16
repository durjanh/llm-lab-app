"""Plain PostgreSQL with pgvector as agent memory: a memories table, an updated_at and a supersedes link.

Uses the lab's container llm-lab-pgvector, but only its own database, `stack_memory_pg`, which is dropped at the end.
A corrected fact is a new row whose `supersedes` points at the old one; the old row is switched off, not deleted,
so the history stays.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/memory
import shared  # noqa: E402
from common import checks, config  # noqa: E402

NAME = "memory/postgres"
if not config.HAS_CLAUDE:
    checks.skip(NAME, "set ANTHROPIC_API_KEY in the lab's .env")
    sys.exit(0)

import numpy as np  # noqa: E402
import psycopg  # noqa: E402
from pgvector.psycopg import register_vector  # noqa: E402

DB = "stack_memory_pg"
BASE = "postgresql://lab:lab@127.0.0.1:5433"
try:
    admin = psycopg.connect(f"{BASE}/postgres", autocommit=True, connect_timeout=5)
except psycopg.OperationalError:
    checks.skip(NAME, "start the lab's llm-lab-pgvector container (127.0.0.1:5433)")
    sys.exit(0)

admin.execute(f"DROP DATABASE IF EXISTS {DB}")
admin.execute(f"CREATE DATABASE {DB}")
try:
    with psycopg.connect(f"{BASE}/{DB}", autocommit=True) as db:
        db.execute("CREATE EXTENSION vector")
        register_vector(db)
        db.execute(f"""CREATE TABLE memories (
            id         serial PRIMARY KEY,
            user_id    text NOT NULL,
            content    text NOT NULL,
            embedding  vector({shared.EMBED_DIM}) NOT NULL,
            session    text NOT NULL,
            active     boolean NOT NULL DEFAULT true,
            supersedes integer REFERENCES memories(id),
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now())""")
        db.execute("CREATE INDEX ON memories USING hnsw (embedding vector_cosine_ops)")

        # Session 1
        for user_msg, _ in shared.SESSION_1_TURNS:
            current = db.execute("SELECT id, content FROM memories WHERE user_id=%s AND active", (shared.USER_ID,)).fetchall()
            out = shared.extract(user_msg, [(str(i), t) for i, t in current])
            old_ids = [int(i) for i in out["supersede"] if i.isdigit() and int(i) in {r[0] for r in current}]
            for n, fact in enumerate(out["add"]):
                link = old_ids[0] if n == 0 and old_ids else None
                db.execute("INSERT INTO memories (user_id, content, embedding, session, supersedes) VALUES (%s,%s,%s,%s,%s)",
                           (shared.USER_ID, fact, np.array(shared.embed([fact])[0]), shared.SESSION_1, link))
            for i in old_ids:
                db.execute("UPDATE memories SET active=false, updated_at=now() WHERE id=%s", (i,))
        rows = db.execute("SELECT id, active, supersedes, content FROM memories ORDER BY id").fetchall()
        print(f"{len(rows)} rows:")
        for r in rows:
            print(f"  #{r[0]} {'active  ' if r[1] else 'inactive'} supersedes={r[2]} {r[3]}")

        def recall(question: str) -> list[str]:
            q = np.array(shared.embed([question])[0])
            got = db.execute("SELECT content FROM memories WHERE user_id=%s AND active ORDER BY embedding <=> %s LIMIT 3",
                             (shared.USER_ID, q)).fetchall()
            return [r[0] for r in got]

        links = sum(1 for r in rows if r[2])
        shared.evaluate(NAME, recall, f"{len(rows)} rows, {links} supersedes link(s)")
finally:
    admin.execute(f"DROP DATABASE IF EXISTS {DB} WITH (FORCE)")
    admin.close()
