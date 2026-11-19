"""Memory stores: folders of small text files an agent reads and writes across sessions, with every change kept.

The same design as Claude Managed Agents' memory stores, built in the lab so it runs on any model and stays on this
machine. A store has a name and a description written for the model. A memory is one text file, addressed by its path.
Every change (created, modified, deleted) is a version that is never edited afterwards, which records who made it (a
coding session's id, or "console" for the page), so the page can show the history, restore an old version, or redact
one that should never have been written. Redacting removes a version's text and keeps the record that it existed.

The coding agent gets a store as a folder, .memory/<store>/ in its project, read-only or read-write, and a note in its
instructions saying so. When a run ends, what it changed there comes back here as versions (see coding.py).

Layout, under generated/memory-stores/<memstore_id>/: store.json, memories.json (each memory's path and current
version) and versions/<memver_id>.json (each version's text, or none once redacted). Writes are whole-file replaces.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from ..core.errors import ApiError
from ..shared import memory_script

MAX_STORES = 30
MAX_MEMORIES = 300  # per store
MAX_MEMORY_BYTES = 100_000  # per memory, as in Managed Agents: prefer many small files
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
STORE_ID = re.compile(r"^memstore_[0-9a-f]{16}$")
MEMORY_ID = re.compile(r"^mem_[0-9a-f]{16}$")
VERSION_ID = re.compile(r"^memver_[0-9a-f]{16}$")
PATH = re.compile(r"^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:md|txt|json|yaml|yml)$")
# Secrets in their usual shapes. Words such as "password" are fine in a lesson ("never log the password"); a key is not.
SECRET = re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|"
                    r"xox[abpr]-[A-Za-z0-9-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AccountKey=[A-Za-z0-9+/=]{40,}")
LESSON_GUIDE = """# How to write to this store

One file per topic, named for it (for example `pytest-setup.md`), each lesson written as:

**What it is about, in one line**
- CONDITION: when this applies, specific enough to recognise.
- ACTION: what to do.
- WHY: what goes wrong otherwise.

After each session, add `sessions/<session id>.md`: what was asked, what was done, what was learned.
Never write keys, passwords or tokens here: memories are read into every later session.
"""


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def problem(path: str, content: str) -> str | None:
    """Why this cannot be stored, or None."""
    if not PATH.match(path) or len(path) > 200:
        return f"{path!r} is not a memory path: letters, digits, - _ . and folders, ending .md, .txt, .json or .yaml."
    if len(content.encode()) > MAX_MEMORY_BYTES:
        return f"{path} is over {MAX_MEMORY_BYTES // 1000} KB. Split it into smaller files."
    if SECRET.search(content):
        return f"{path} holds what looks like a key or token. Memories are read into every later session."
    if memory_script.privacy_problem(content) == "a payment card number":  # its other patterns are words, fine here
        return f"{path} holds a payment card number."
    return None


def clash(memories: dict[str, dict[str, Any]], path: str, own_id: str | None = None) -> str | None:
    """Why this path cannot sit beside the live memories: the same name in other letters (one file on a Mac's disk,
    where a store is mounted), or a file where a folder is, or the other way round."""
    low = path.lower()
    for m in memories.values():
        if not m["current"] or m["id"] == own_id:
            continue
        other = m["path"].lower()
        if other == low:
            return f"{path} clashes with {m['path']}: names that differ only in capitals are one file when mounted."
        if low.startswith(other + "/") or other.startswith(low + "/"):
            return f"{path} clashes with {m['path']}: a path cannot be both a file and a folder."
    return None


class MemoryStores:
    def __init__(self, root: Path):
        self.root = root
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()
        self._creating = threading.Lock()  # one check-and-create at a time: names stay unique, the cap holds

    # ----- files -----

    def _lock(self, store_id: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(store_id, threading.Lock())

    def _dir(self, store_id: str) -> Path:
        if not STORE_ID.match(store_id or ""):
            raise ApiError(404, "not_found", "No such memory store.")
        folder = self.root / store_id
        if not (folder / "store.json").exists():
            raise ApiError(404, "not_found", "No such memory store.")
        return folder

    @staticmethod
    def _still_there(folder: Path) -> None:
        """Checked again once the store's lock is held: a write that waited behind delete_store must not re-create the
        folder it removed (an orphan with no store.json, and a write reported as saved)."""
        if not (folder / "store.json").exists():
            raise ApiError(404, "not_found", "That memory store has gone.")

    @staticmethod
    def _read(path: Path) -> Any:
        try:
            return json.loads(path.read_text())
        except FileNotFoundError:  # deleted while being read, by another tab or session
            raise ApiError(404, "not_found", "That memory store has gone.") from None

    @staticmethod
    def _write(path: Path, data: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_suffix(path.suffix + ".part")
        part.write_text(json.dumps(data, indent=1))
        part.replace(path)

    def _memories(self, folder: Path) -> dict[str, dict[str, Any]]:
        f = folder / "memories.json"
        return self._read(f) if f.exists() else {}

    def _version(self, folder: Path, version_id: str) -> dict[str, Any]:
        if not VERSION_ID.match(version_id or ""):
            raise ApiError(404, "not_found", "No such version.")
        f = folder / "versions" / f"{version_id}.json"
        if not f.exists():
            raise ApiError(404, "not_found", "No such version.")
        return self._read(f)

    def _add_version(self, folder: Path, memories: dict, memory: dict, operation: str, content: str | None,
                     by: str) -> dict[str, Any]:
        v = {"id": new_id("memver"), "memory_id": memory["id"], "path": memory["path"], "operation": operation,
             "content": content, "sha256": sha(content) if content is not None else None,
             "size": len(content.encode()) if content is not None else 0, "at": time.time(), "by": by,
             "redacted": False}
        self._write(folder / "versions" / f"{v['id']}.json", v)
        memory.update(current=None if operation == "deleted" else v["id"], updated_at=v["at"], updated_by=by,
                      size=v["size"], versions=[*memory.get("versions", []), v["id"]])
        memories[memory["id"]] = memory
        return v

    # ----- stores -----

    def list(self) -> list[dict[str, Any]]:
        if not self.root.exists():
            return []
        out = []
        for f in sorted(self.root.glob("memstore_*/store.json")):
            try:
                store = self._read(f)
                live = [m for m in self._memories(f.parent).values() if m["current"]]
            except ApiError:  # deleted while listing
                continue
            out.append({**store, "memories": len(live), "bytes": sum(m["size"] for m in live)})
        return sorted(out, key=lambda s: -s["created_at"])

    def create(self, name: str, description: str, seed_guide: bool = True) -> dict[str, Any]:
        name = (name or "").strip().lower()
        if not NAME.match(name):
            raise ApiError(400, "invalid_request", "A store name is 2 to 41 lower-case letters, digits or hyphens.")
        with self._creating:
            stores = self.list()
            if any(s["name"] == name for s in stores):
                raise ApiError(409, "name_taken", f"There is already a store called {name}.")
            if len(stores) >= MAX_STORES:
                raise ApiError(400, "too_many_stores", f"The lab holds {MAX_STORES} stores. Delete one first.")
            store = {"id": new_id("memstore"), "name": name, "description": (description or "").strip()[:2000],
                     "created_at": time.time()}
            self._write(self.root / store["id"] / "store.json", store)
            if seed_guide:  # inside the lock: a list or a mount never sees the store before its guide
                self.add(store["id"], "README.md", LESSON_GUIDE, by="console")
        return self.get(store["id"])

    def get(self, store_id: str) -> dict[str, Any]:
        folder = self._dir(store_id)
        memories = [{k: m[k] for k in ("id", "path", "size", "updated_at", "updated_by")} | {"versions": len(m["versions"])}
                    for m in self._memories(folder).values() if m["current"]]
        return {**self._read(folder / "store.json"), "memories": sorted(memories, key=lambda m: m["path"])}

    def describe(self, store_id: str, description: str) -> dict[str, Any]:
        folder = self._dir(store_id)
        with self._lock(store_id):
            self._still_there(folder)
            store = self._read(folder / "store.json")
            store["description"] = (description or "").strip()[:2000]
            self._write(folder / "store.json", store)
        return self.get(store_id)

    def delete_store(self, store_id: str) -> dict[str, Any]:
        folder = self._dir(store_id)
        with self._lock(store_id):
            self._still_there(folder)
            shutil.rmtree(folder)
        with self._guard:
            self._locks.pop(store_id, None)
        return {"deleted": store_id}

    # ----- memories -----

    def contents(self, store_id: str) -> dict[str, str]:
        """Every live memory's text, by path: what a session mounts."""
        folder = self._dir(store_id)
        out = {}
        for m in self._memories(folder).values():
            if m["current"]:
                out[m["path"]] = self._version(folder, m["current"])["content"] or ""
        return out

    def memory(self, store_id: str, memory_id: str) -> dict[str, Any]:
        folder = self._dir(store_id)
        m = self._memories(folder).get(memory_id) if MEMORY_ID.match(memory_id or "") else None
        if m is None:
            raise ApiError(404, "not_found", "No such memory.")
        versions = [self._version(folder, v) for v in reversed(m["versions"])]
        current = next((v for v in versions if v["id"] == m["current"]), None)
        return {**{k: m[k] for k in ("id", "path", "size", "updated_at", "updated_by")},
                "content": current["content"] if current else None,
                "versions": [{k: v[k] for k in ("id", "operation", "at", "by", "size", "redacted")} for v in versions]}

    def _by_path(self, memories: dict, path: str) -> dict[str, Any] | None:
        return next((m for m in memories.values() if m["path"] == path and m["current"]), None)

    def add(self, store_id: str, path: str, content: str, by: str = "console") -> dict[str, Any]:
        folder = self._dir(store_id)
        if why := problem(path, content):
            raise ApiError(400, "invalid_request", why)
        with self._lock(store_id):
            self._still_there(folder)
            memories = self._memories(folder)
            if existing := self._by_path(memories, path):
                raise ApiError(409, "memory_path_conflict", f"{path} already exists ({existing['id']}).")
            if why := clash(memories, path):
                raise ApiError(409, "memory_path_conflict", why)
            if sum(1 for m in memories.values() if m["current"]) >= MAX_MEMORIES:
                raise ApiError(400, "store_full", f"A store holds {MAX_MEMORIES} memories.")
            memory = {"id": new_id("mem"), "path": path, "created_at": time.time(), "versions": []}
            self._add_version(folder, memories, memory, "created", content, by)
            self._write(folder / "memories.json", memories)
        return self.memory(store_id, memory["id"])

    def update(self, store_id: str, memory_id: str, content: str, by: str = "console") -> dict[str, Any]:
        folder = self._dir(store_id)
        with self._lock(store_id):
            self._still_there(folder)
            memories = self._memories(folder)
            m = memories.get(memory_id)
            if not m or not m["current"]:
                raise ApiError(404, "not_found", "No such memory.")
            if why := problem(m["path"], content):
                raise ApiError(400, "invalid_request", why)
            if self._version(folder, m["current"])["sha256"] != sha(content):
                self._add_version(folder, memories, m, "modified", content, by)
                self._write(folder / "memories.json", memories)
        return self.memory(store_id, memory_id)

    def delete(self, store_id: str, memory_id: str, by: str = "console") -> dict[str, Any]:
        folder = self._dir(store_id)
        with self._lock(store_id):
            self._still_there(folder)
            memories = self._memories(folder)
            m = memories.get(memory_id)
            if not m or not m["current"]:
                raise ApiError(404, "not_found", "No such memory.")
            self._add_version(folder, memories, m, "deleted", None, by)
            self._write(folder / "memories.json", memories)
        return {"deleted": memory_id}

    def version(self, store_id: str, version_id: str) -> dict[str, Any]:
        return self._version(self._dir(store_id), version_id)

    def restore(self, store_id: str, version_id: str, by: str = "console") -> dict[str, Any]:
        """Makes an old version current again, as a new version: history only grows."""
        folder = self._dir(store_id)
        with self._lock(store_id):
            self._still_there(folder)
            v = self._version(folder, version_id)
            if v["content"] is None:
                raise ApiError(400, "invalid_request", "That version has no text to restore (a deletion, or redacted).")
            memories = self._memories(folder)
            m = memories[v["memory_id"]]
            if why := clash(memories, m["path"], own_id=m["id"]):
                raise ApiError(409, "memory_path_conflict", why)
            if (taken := self._by_path(memories, m["path"])) and taken["id"] != m["id"]:
                raise ApiError(409, "memory_path_conflict", f"{m['path']} is now used by {taken['id']}.")
            if m["current"] and self._version(folder, m["current"])["sha256"] == v["sha256"]:
                return self.memory(store_id, v["memory_id"])  # already the current text: no empty version
            self._add_version(folder, memories, m, "created" if not m["current"] else "modified", v["content"],
                              f"{by} (restored {version_id})")
            self._write(folder / "memories.json", memories)
        return self.memory(store_id, v["memory_id"])

    def redact(self, store_id: str, version_id: str) -> dict[str, Any]:
        """Removes a version's text for good, keeping the record that it existed. A current version cannot be
        redacted while it is current: change or delete the memory first, so the text is not still being served."""
        folder = self._dir(store_id)
        with self._lock(store_id):
            self._still_there(folder)
            v = self._version(folder, version_id)
            if self._memories(folder)[v["memory_id"]]["current"] == version_id:
                raise ApiError(400, "invalid_request", "That is the memory's current text. Change or delete the "
                                                       "memory first, then redact this version.")
            v.update(content=None, sha256=None, redacted=True)
            self._write(folder / "versions" / f"{version_id}.json", v)
        return {"redacted": version_id}

    # ----- a session's changes -----

    def apply(self, store_id: str, mounted: dict[str, str], now: dict[str, str], by: str) -> list[dict[str, Any]]:
        """What a session changed in its copy of the store, saved as versions. `mounted` is what the session was given
        (path to text), `now` what its folder holds at the end of a run. Each change is checked like any other write;
        one that fails is refused and reported. When the store changed since the session mounted it, the session's
        version still wins, and the change says so: the other one is in the history."""
        folder = self._dir(store_id)
        changes: list[dict[str, Any]] = []
        with self._lock(store_id):
            self._still_there(folder)
            memories = self._memories(folder)
            for path in sorted(set(mounted) | set(now)):
                before, after = mounted.get(path), now.get(path)
                if before == after:
                    continue
                m = self._by_path(memories, path)
                current = self._version(folder, m["current"])["content"] if m else None
                moved = current != before  # another session or the page changed it meanwhile
                if after is None:
                    if m:
                        self._add_version(folder, memories, m, "deleted", None, by)
                    changes.append({"path": path, "operation": "deleted", "conflict": moved})
                    continue
                if why := problem(path, after) or (None if m else clash(memories, path)):
                    changes.append({"path": path, "operation": "refused", "reason": why})
                    continue
                if m is None:
                    if sum(1 for x in memories.values() if x["current"]) >= MAX_MEMORIES:
                        changes.append({"path": path, "operation": "refused", "reason": "the store is full"})
                        continue
                    m = {"id": new_id("mem"), "path": path, "created_at": time.time(), "versions": []}
                    v = self._add_version(folder, memories, m, "created", after, by)
                elif current == after:
                    continue
                else:
                    v = self._add_version(folder, memories, m, "modified", after, by)
                changes.append({"path": path, "operation": v["operation"], "memory_id": m["id"], "version_id": v["id"],
                                "conflict": moved})
            self._write(folder / "memories.json", memories)
        return changes
