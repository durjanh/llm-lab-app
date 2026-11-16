# PostgreSQL MCP server

**Which server.** The reference `@modelcontextprotocol/server-postgres` was archived (and deprecated on npm). `crystaldba/postgres-mcp` ("Postgres MCP Pro", Apache-2.0) is maintained and has a real restricted mode, so this example uses its image `crystaldba/postgres-mcp:0.3.0`.

**Why Docker.** The PyPI package `postgres-mcp` needs `pglast==7.2.0`, which has no wheel for this machine's Python 3.12, and it pins an older `mcp` than the 2.x client. The image has none of those problems and keeps the server's code apart from the client's venv.

**How it does the task.** `run.py` creates database `stack_mcp` in the lab's `llm-lab-pgvector` container, loads a `sections(id, title, body)` table, and starts the image over stdio with `--access-mode=restricted` and the database URL in `DATABASE_URI` (via `host.docker.internal`, since the container cannot see the host's `127.0.0.1`). Claude calls `list_schemas`, `get_object_details` and `execute_sql`, and finds that Equipment mentions extension 4400. Afterwards the script sends `DELETE FROM sections` straight to the server, to confirm restricted mode refuses it, and checks that all 12 rows are still there. The database is dropped in a `finally` block, and the container is removed.

**Allow-list.** `list_schemas`, `list_objects`, `get_object_details`, `execute_sql`. Of the server's 9 tools, the index-tuning and health tools (`explain_query`, `analyze_*`, `get_top_queries`) are not offered.

**Limits.** Restricted mode wraps queries in read-only transactions and parses them first; it is a guard, not a substitute for a read-only database role. The server only speaks stdio and SSE, not Streamable HTTP, and it does not answer the 2.x client's discovery probe, so `run.py` connects with `mode="legacy"`.

Ran on 2026-11-15: PASS, found Equipment via SQL, table intact (12 rows); the DELETE was refused.
