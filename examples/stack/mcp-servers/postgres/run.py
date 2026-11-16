"""Postgres MCP server: Claude finds the handbook section that mentions extension 4400 by writing SQL.

Creates the database stack_mcp in the lab's llm-lab-pgvector container with a table of the 12 sections, starts
crystaldba/postgres-mcp (Postgres MCP Pro) in Docker over stdio in restricted (read-only) mode, and drops the database
at the end. The model sees only the schema and query tools; the index and health tools are not offered.
"""
import asyncio
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse, urlunparse

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/mcp-servers
from common import checks, config, data  # noqa: E402
import shared  # noqa: E402

NAME = "mcp-servers/postgres"
IMAGE = "crystaldba/postgres-mcp:0.3.0"
DB = "stack_mcp"
READ_ONLY = {"list_schemas", "list_objects", "get_object_details", "execute_sql"}
TASK = "Which section of the handbook mentions extension 4400? Query the sections table. Give the section title."


def admin_url(db: str) -> str:
    """The lab's PostgreSQL URL (user, password, host, port) pointing at another database."""
    u = urlparse(config.PGVECTOR_URL)
    return urlunparse(u._replace(path=f"/{db}"))


async def main() -> None:
    import psycopg
    from mcp import Client, StdioServerParameters

    if not config.HAS_CLAUDE:
        return checks.skip(NAME, "set ANTHROPIC_API_KEY")
    if not shared.docker_ready():
        return checks.skip(NAME, "start Docker (the server runs from the image " + IMAGE + ")")
    try:
        admin = psycopg.connect(admin_url("postgres"), autocommit=True, connect_timeout=5)
    except psycopg.Error:
        return checks.skip(NAME, "start the lab's llm-lab-pgvector container (127.0.0.1:5433)")
    admin.execute(f"DROP DATABASE IF EXISTS {DB}")
    admin.execute(f"CREATE DATABASE {DB}")
    try:
        with psycopg.connect(admin_url(DB)) as conn:
            conn.execute("CREATE TABLE sections (id serial PRIMARY KEY, title text NOT NULL, body text NOT NULL)")
            for title, text in data.SECTIONS:
                conn.execute("INSERT INTO sections (title, body) VALUES (%s, %s)", (title, text))
        # The container reaches the host's published port through host.docker.internal.
        u = urlparse(config.PGVECTOR_URL)
        inside = urlunparse(u._replace(netloc=f"{u.username}:{u.password}@host.docker.internal:{u.port}", path=f"/{DB}"))
        params = StdioServerParameters(
            command="docker",
            args=["run", "-i", "--rm", "--name", "stack-mcp-servers-postgres", "-e", "DATABASE_URI", IMAGE,
                  "--access-mode=restricted"],
            env={"DATABASE_URI": inside, "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"})
        # This server speaks the 2025 protocol, so skip the 2.x client's discovery probe.
        async with Client(params, mode="legacy") as mcp:
            text, called = await shared.answer(mcp, TASK, READ_ONLY, "A PostgreSQL database holds the company handbook.")
            # Restricted mode must refuse a write; check it, since it is the point of the mode.
            blocked = await mcp.call_tool("execute_sql", {"sql": "DELETE FROM sections"})
            print(f"  write attempt refused: {blocked.is_error or 'error' in shared.text_of(blocked).lower()}")
        with psycopg.connect(admin_url(DB)) as conn:
            rows = conn.execute("SELECT count(*) FROM sections").fetchone()[0]
        ok = bool(called) and "equipment" in text.lower() and rows == len(data.SECTIONS)
        checks.report(NAME, ok, f"found Equipment via SQL, table intact ({rows} rows)" if ok else f"answer: {text[:120]}")
    finally:
        subprocess.run(["docker", "rm", "-f", "stack-mcp-servers-postgres"], capture_output=True)  # in case it lingers
        admin.execute(f"DROP DATABASE IF EXISTS {DB} WITH (FORCE)")
        admin.close()


if __name__ == "__main__":
    asyncio.run(main())
