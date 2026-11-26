"""The assistant page's chats on disk: one folder per chat, its conversation in the lab's ConversationStore.

Layout, under generated/assistant/:
  <chat_id>/chat.json          title, settings, the turns as the page shows them, uploads and made files
  <chat_id>/log/<turn_id>.jsonl every event of a turn, in order, with full tool output
  <chat_id>/workspace/         the main agent's sandbox folder: inputs/ (uploads), work/, outputs/, skills/
  <chat_id>/agents/<turn>-<k>/ a sub-agent's own sandbox folder, so agents run in parallel without sharing files
  <chat_id>/versions/          a copy of every upload and made file as it was registered, so an old link still
                               returns the old file after the agent writes a new one under the same name
  _steps/                      the conversations themselves, in the ConversationStore layout (FileStore), kept apart
                               from /model-failover's store so the two labs never mix

A chat id is 128 random bits: it is also the key to the chat's files on the media route, which cannot send the lab
header. At most MAX_CHATS chats are kept: making a new one deletes the oldest idle chats beyond that, folder and all
(the service does it, so a chat in use is never deleted).
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..core.errors import ApiError
from ..shared import sandbox_skills as S
from .conversation_store import ConversationStore, FileStore

CHAT_ID = re.compile(r"^[0-9a-f]{32}$")
FILE_ID = re.compile(r"^[0-9a-f]{16}$")
TURN_ID = re.compile(r"^[0-9a-f]{12}$")
MAX_CHATS = 100  # retention: older idle chats are deleted when a new one is made
MAX_FILES = 10  # per upload request
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_CHAT_UPLOAD_BYTES = 500 * 1024 * 1024  # all of one chat's uploads together
MAX_OUTPUT_FILE_BYTES = 200 * 1024 * 1024  # a made file larger than this is not offered (nor hashed, nor copied)
CHUNK = 1024 * 1024
MAX_TITLE = 120
SKILLS = ["pptx", "xlsx", "docx", "pdf", "number-profile"]
UPLOAD_EXTENSIONS = ["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "csv", "tsv", "txt", "md", "json", "xml",
                     "html", "htm", "yaml", "yml", "py", "js", "ts", "sql", "log", "png", "jpg", "jpeg", "gif", "webp",
                     "zip"]
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
DEFAULT_TITLE = "New chat"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def media_type(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def safe_name(name: str) -> str:
    """A file name with nothing that could leave its folder: the last part only, unusual characters replaced."""
    safe = re.sub(r"[^\w.\- ]", "_", Path(name or "").name).strip(" .") or "file"
    return safe[:120]


def content_id(rel: str, data: bytes) -> str:
    """An id for one version of a file: its path and content, so a changed file gets a new id."""
    return hashlib.sha256(rel.encode() + b"\0" + data).hexdigest()[:16]


def file_content_id(rel: str, path: Path) -> str:
    """content_id of a file on disk, read in chunks so a large file never sits in memory whole."""
    h = hashlib.sha256(rel.encode() + b"\0")
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()[:16]


class TooLarge(Exception):
    """A made file over MAX_OUTPUT_FILE_BYTES: it is left where it is and not offered to the page."""

    def __init__(self, size: int):
        super().__init__(size)
        self.size = size


def inside(root: Path, rel: str) -> Path | None:
    """`rel` under `root`, or None when it would leave root or is a link (a link made in the sandbox could point
    anywhere on this machine)."""
    try:
        path = (root / rel)
        if path.is_symlink() or any(p.is_symlink() for p in path.parents if p.is_relative_to(root)):
            return None
        resolved = path.resolve()
        return resolved if resolved.is_relative_to(root.resolve()) else None
    except (OSError, ValueError):
        return None


class ChatStore:
    """Chat folders, their chat.json and logs. One lock per store keeps read-modify-write of chat.json whole."""

    def __init__(self, folder: Path, steps: ConversationStore | None = None):
        self.folder = Path(folder)
        self.steps = steps or FileStore(self.folder / "_steps")
        self._lock = threading.RLock()

    # ----- paths -----
    def chat_dir(self, chat_id: str) -> Path:
        if not CHAT_ID.match(chat_id or ""):
            raise ApiError(404, "not_found", "No such chat.")
        return self.folder / chat_id

    def workspace(self, chat_id: str) -> Path:
        return self.chat_dir(chat_id) / "workspace"

    def agent_root(self, chat_id: str, turn_id: str, k: int) -> Path:
        return self.chat_dir(chat_id) / "agents" / f"{turn_id}-{k}"

    # ----- chat.json -----
    def _meta_path(self, chat_id: str) -> Path:
        return self.chat_dir(chat_id) / "chat.json"

    def read(self, chat_id: str) -> dict[str, Any]:
        path = self._meta_path(chat_id)
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise ApiError(404, "not_found", "No such chat.") from None

    def _write(self, meta: dict[str, Any]) -> None:
        path = self._meta_path(meta["id"])
        tmp = path.with_name(f"chat.{uuid.uuid4().hex[:6]}.tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(path)  # a reader never sees half a file

    def update(self, chat_id: str, change: Any) -> dict[str, Any]:
        """Reads chat.json, lets `change` edit it in place, and writes it back, all under the lock."""
        with self._lock:
            meta = self.read(chat_id)
            change(meta)
            meta["updated_at"] = now_iso()
            self._write(meta)
            return meta

    def create(self, settings: dict[str, Any]) -> dict[str, Any]:
        chat_id = uuid.uuid4().hex
        conv = self.steps.create()
        folder = self.folder / chat_id
        ws = folder / "workspace"
        for d in ("inputs", "work", "outputs"):
            (ws / d).mkdir(parents=True, exist_ok=True)
        copy_skills(ws)
        (folder / "log").mkdir(exist_ok=True)
        meta = {"id": chat_id, "conv_id": conv.id, "title": DEFAULT_TITLE, "created_at": now_iso(),
                "updated_at": now_iso(), "settings": settings, "uploads": [], "files": {}, "turns": []}
        with self._lock:
            self._write(meta)
        return meta

    def list(self) -> list[dict[str, Any]]:
        out = []
        if not self.folder.is_dir():
            return out
        for d in self.folder.iterdir():
            if CHAT_ID.match(d.name) and (d / "chat.json").is_file():
                try:
                    out.append(json.loads((d / "chat.json").read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    continue  # a damaged file is skipped, not fatal for the list
        return sorted(out, key=lambda m: m.get("updated_at", ""), reverse=True)

    def delete(self, chat_id: str) -> None:
        meta = self.read(chat_id)
        try:
            self.steps.delete(meta["conv_id"])
        except Exception:  # noqa: BLE001  (already gone): the folder still goes
            pass
        shutil.rmtree(self.chat_dir(chat_id), ignore_errors=True)

    def beyond(self, keep: int | None = None) -> list[str]:
        """The chats past the newest `keep` (MAX_CHATS), oldest last: the ones retention would delete."""
        return [m["id"] for m in self.list()[MAX_CHATS if keep is None else keep:]]

    # ----- files -----
    def add_uploads(self, chat_id: str, files: list[tuple[str, bytes]], cap: int) -> list[dict[str, Any]]:
        """Saves several uploads, checking the chat's total against `cap` under the lock, so two uploads at once cannot
        pass the check together and go over it."""
        with self._lock:
            total = self.upload_bytes(chat_id) + sum(len(d) for _, d in files)
            if total > cap:
                raise ApiError(413, "too_large", f"A chat can hold at most {cap // 2**20} MB of uploads. Start a new "
                                                 "chat for more files.")
            return [self.add_upload(chat_id, name, data) for name, data in files]

    def add_upload(self, chat_id: str, name: str, data: bytes) -> dict[str, Any]:
        """Saves an upload in inputs/. A name already there gets a number, so nothing earlier is overwritten."""
        ws = self.workspace(chat_id)
        base = safe_name(name)
        stem, dot, ext = base.rpartition(".")
        with self._lock:
            target, n = ws / "inputs" / base, 1
            while target.exists():
                n += 1
                target = ws / "inputs" / (f"{stem} ({n}).{ext}" if dot else f"{base} ({n})")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            rel = f"workspace/inputs/{target.name}"
            record = {"id": content_id(rel, data), "name": target.name, "size": len(data),
                      "media_type": media_type(target.name), "source": rel, "previews": [], "created_at": now_iso()}
            record["path"] = self._keep_version(chat_id, record["id"], target.name, data)
            self.update(chat_id, lambda m: m["uploads"].append(record))
        return record

    def register_file(self, chat_id: str, path: Path, turn_id: str, agent: str) -> dict[str, Any] | None:
        """Records a made file (in some outputs/ folder of the chat) so the media route can serve it. The file is
        kept as this version: a later turn writing the same name gets a new id, and the old id still returns this."""
        folder = self.chat_dir(chat_id)
        try:
            size = path.stat().st_size
            if size > MAX_OUTPUT_FILE_BYTES:
                raise TooLarge(size)
            rel = path.resolve().relative_to(folder.resolve()).as_posix()
            file_id = file_content_id(rel, path)
            kept = self._keep_version(chat_id, file_id, path.name, source=path)
        except (OSError, ValueError):
            return None  # gone or unreadable since it was seen: nothing to offer
        record = {"id": file_id, "name": path.name, "size": size, "media_type": media_type(path.name),
                  "source": rel, "previews": [], "created_at": now_iso(), "turn_id": turn_id, "agent": agent,
                  "path": kept}
        if record["media_type"] in IMAGE_TYPES or record["media_type"] == "image/svg+xml":
            record["previews"] = ["self"]
        self.update(chat_id, lambda m: m["files"].__setitem__(record["id"], record))
        return record

    def _keep_version(self, chat_id: str, file_id: str, name: str, data: bytes | None = None,
                      source: Path | None = None) -> str:
        """A copy of this version of a file, outside the sandbox's folder, so nothing the agent does changes it.
        Copied from `source` by streaming, or written from `data` (an upload, already in memory)."""
        target = self.chat_dir(chat_id) / "versions" / f"{file_id}{Path(name).suffix.lower()[:12]}"
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(target.name + ".tmp")
            if source is not None:
                shutil.copyfile(source, tmp)
            else:
                tmp.write_bytes(data or b"")
            tmp.replace(target)
        return target.relative_to(self.chat_dir(chat_id)).as_posix()

    def upload_bytes(self, chat_id: str) -> int:
        return sum(u.get("size", 0) for u in self.read(chat_id)["uploads"])

    def set_previews(self, chat_id: str, file_id: str, previews: list[str]) -> dict[str, Any] | None:
        out: dict[str, Any] = {}

        def change(m: dict[str, Any]) -> None:
            if file_id in m["files"]:
                m["files"][file_id]["previews"] = previews
                out.update(m["files"][file_id])
        self.update(chat_id, change)
        return out or None

    def find_file(self, chat_id: str, file_id: str) -> dict[str, Any] | None:
        if not FILE_ID.match(file_id or ""):
            return None
        meta = self.read(chat_id)
        return meta["files"].get(file_id) or next((u for u in meta["uploads"] if u["id"] == file_id), None)

    def file_path(self, chat_id: str, rel: str) -> Path | None:
        path = inside(self.chat_dir(chat_id), rel)
        return path if path is not None and path.is_file() else None

    # ----- logs -----
    def append_log(self, chat_id: str, turn_id: str, event: dict[str, Any]) -> None:
        path = self.chat_dir(chat_id) / "log" / f"{turn_id}.jsonl"
        line = json.dumps(event, ensure_ascii=False, default=str)
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")

    def read_log(self, chat_id: str, turn_id: str) -> list[dict[str, Any]]:
        if not TURN_ID.match(turn_id or ""):
            raise ApiError(404, "not_found", "No such turn.")
        path = self.chat_dir(chat_id) / "log" / f"{turn_id}.jsonl"
        if not path.is_file():
            raise ApiError(404, "not_found", "No such turn.")
        out = []
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue  # a line cut short by a crash
        return out

    def log_count(self, chat_id: str, turn_id: str) -> int:
        path = self.chat_dir(chat_id) / "log" / f"{turn_id}.jsonl"
        try:
            with path.open(encoding="utf-8") as f:
                return sum(1 for _ in f)
        except OSError:
            return 0


def copy_skills(root: Path) -> None:
    """The lab's skills (pptx, xlsx, docx, pdf, number-profile), copied in so their scripts run in the sandbox."""
    for name in SKILLS:
        target = root / "skills" / name
        if not target.exists() and (S.SKILLS_DIR / name).is_dir():
            shutil.copytree(S.SKILLS_DIR / name, target, ignore=shutil.ignore_patterns("__pycache__"))


def file_hash(path: Path) -> str:
    """A file's content hash, read in chunks. Over MAX_OUTPUT_FILE_BYTES its size and time stand in for it: such a file
    is never offered, so reading gigabytes to tell versions apart would be wasted."""
    st = path.stat()
    if st.st_size > MAX_OUTPUT_FILE_BYTES:
        return f"large:{st.st_size}:{st.st_mtime_ns}"
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def snapshot(outputs: Path, previous: dict[Path, tuple[int, int, str]] | None = None) -> dict[Path, tuple[int, int, str]]:
    """Every file in an outputs/ folder as (size, modified time, content hash). A file whose size and time match
    `previous` keeps its hash without being read again. Links are left out: they could point anywhere."""
    out: dict[Path, tuple[int, int, str]] = {}
    if not outputs.is_dir():
        return out
    previous = previous or {}
    for p in sorted(outputs.rglob("*")):
        try:
            if p.is_symlink() or not p.is_file() or any(q.is_symlink() for q in p.parents if q.is_relative_to(outputs)):
                continue
            st = p.stat()
            old = previous.get(p)
            same = old is not None and old[0] == st.st_size and old[1] == st.st_mtime_ns
            out[p] = (st.st_size, st.st_mtime_ns, old[2] if same else file_hash(p))
        except OSError:
            continue
    return out


def public_file(chat_id: str, record: dict[str, Any]) -> dict[str, Any]:
    """A file as the page sees it: its media-route URL and preview URLs, never its path on this machine."""
    url = f"/api/assistant/media/{chat_id}/{record['id']}"
    previews = [url if p == "self" else f"{url}/preview/{i}" for i, p in enumerate(record.get("previews") or [])]
    return {"id": record["id"], "name": record["name"], "size": record["size"], "media_type": record["media_type"],
            "url": url, "previews": previews}


def stamp() -> int:
    return int(time.time() * 1000)
