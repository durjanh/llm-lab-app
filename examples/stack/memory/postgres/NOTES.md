# Plain PostgreSQL with pgvector as memory

**What it is.** The lab's own `llm-lab-pgvector` container (PostgreSQL 17 with the pgvector extension). This example makes its own database, `stack_memory_pg`, and drops it at the end.

**What kind of memory.** A store, but a relational one, so history is easy to keep. The `memories` table has `content`, a 384-dimension `embedding` (local BGE small, HNSW cosine index), `session`, `active`, `created_at`, `updated_at` and `supersedes` (a foreign key to the row it replaces).

**How it does the task.** Claude extracts facts as in `chroma/`. A correction inserts a new row with `supersedes = <old id>` and switches the old row off (`active = false`, `updated_at = now()`); the row stays for audit. Session 2 runs `ORDER BY embedding <=> query LIMIT 3` over active rows.

**Limits.** Same as any plain store: the decision about what is the same fact is made by Claude, not by the database. Nothing here removes memories for ageing or decay.

Ran on 2026-11-15: PASS memory/postgres: 5/5 answers correct, corrected fact £450 won; 7 rows, 1 supersedes link(s)
