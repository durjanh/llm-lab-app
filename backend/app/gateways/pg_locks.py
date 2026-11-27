"""PostgreSQL advisory locks, so separate processes (the backend, a tools/ script, two backends) take turns at work
that must not run twice at once. Every key is built here, in one namespace, so two features never share a lock by
accident. A transaction lock ends with its transaction; a session lock lasts until it is unlocked or its connection
closes, so a process that dies lets go of it."""
from __future__ import annotations

from typing import Any

PREFIX = "llm-lab"


def key(*parts: str) -> str:
    """The lock's name, from its parts: `key("shop", "import")` is "llm-lab:shop:import"."""
    return ":".join((PREFIX, *parts))


def xact_lock(conn: Any, *parts: str) -> None:
    """Waits for the lock and holds it until the current transaction ends."""
    conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (key(*parts),))


def try_lock(conn: Any, *parts: str) -> bool:
    """Takes the lock for this connection's session without waiting. False when another session holds it."""
    return bool(conn.execute("SELECT pg_try_advisory_lock(hashtext(%s))", (key(*parts),)).fetchone()[0])


def unlock(conn: Any, *parts: str) -> None:
    conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (key(*parts),))
