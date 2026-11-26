"""Files a person attaches to a site builder message: a screenshot to work from, a data file for the site, a PDF brief.

They are uploaded before the message is sent, often before the site exists (the first message makes it), so they wait
in generated/site-uploads/<id>/ until a message uses them. Each upload is checked by its content, not only its name:
images must open as the image they claim to be (and are shrunk if very large), text files must be UTF-8, PDFs must
start like one. Uploads are deleted once a message has used them, and any left unused for a day are deleted too.
"""
from __future__ import annotations

import io
import json
import re
import secrets
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path, PurePath
from typing import Any

from ..core.errors import ApiError

IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
               ".gif": "image/gif"}
DATA_TYPES = {".csv": "text/csv", ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain",
              ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml"}
PDF_TYPES = {".pdf": "application/pdf"}
MAX_IMAGE_BYTES = 5 * 2**20
MAX_PDF_BYTES = 10 * 2**20
MAX_DATA_BYTES = 300_000  # a data file is copied into the site, whose files may each be at most this size
MAX_FILES = 6  # per upload, and per message
MAX_IMAGE_EDGE = 1568  # longer than this, a picture is shrunk: the model would scale it down anyway
MAX_PIXELS = 40_000_000  # read from the header before decoding, so a small file cannot unpack into gigabytes
MAX_WAITING_FILES = 60  # uploads waiting for a message, all together
MAX_WAITING_BYTES = 200 * 2**20
MAX_CALLER_FILES = 20  # and for one caller (one browser tab), so one cannot take the whole allowance
MAX_CALLER_BYTES = 60 * 2**20
CALLER = re.compile(r"^[0-9a-zA-Z_-]{8,64}$")
TTL_S = 24 * 3600
UPLOAD_ID = re.compile(r"^[0-9a-f]{32}$")
PIL_FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP", "image/gif": "GIF"}


@dataclass
class Upload:
    id: str
    name: str
    media_type: str
    kind: str  # image, data or pdf
    size: int
    path: Path

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "size": self.size, "media_type": self.media_type, "kind": self.kind}


def clean_name(name: str) -> str:
    """A safe file name: no folders, only ordinary characters, no leading dot, at most 80 characters."""
    base = PurePath(name.replace("\\", "/")).name
    base = re.sub(r"[^\w.\- ]", "_", base).strip().lstrip(".")
    stem, dot, ext = base.rpartition(".")
    if not dot:
        stem, ext = base, ""
    stem = stem[: 80 - len(ext) - 1] or "file"
    return f"{stem}.{ext.lower()}" if ext else stem


def kind_of(name: str) -> tuple[str, str] | None:
    """The kind and media type a file name stands for, or None when it is not accepted."""
    ext = PurePath(name).suffix.lower()
    if ext in IMAGE_TYPES:
        return "image", IMAGE_TYPES[ext]
    if ext in DATA_TYPES:
        return "data", DATA_TYPES[ext]
    if ext in PDF_TYPES:
        return "pdf", PDF_TYPES[ext]
    return None


def checked_image(raw: bytes, media_type: str) -> tuple[bytes, str]:
    """The picture, opened to prove it is one of the accepted formats, and shrunk if its longer side is over
    MAX_IMAGE_EDGE. A GIF becomes a PNG of its first frame. Raises ValueError for anything that is not a picture."""
    from PIL import Image, UnidentifiedImageError

    # The size is read from the header and checked before anything is decoded. MAX_PIXELS is well under Pillow's own
    # limit, so Pillow never needs to warn; above its limit it raises DecompressionBombError itself, caught below.
    # No warning filter is changed: that is process-wide state, and uploads are checked in several threads at once.
    try:
        with Image.open(io.BytesIO(raw)) as probe:  # reads the header only
            width, height = probe.size
            if width * height > MAX_PIXELS:
                raise OverflowError(f"at {width:,} × {height:,} pixels it is too large; the most is "
                                    f"{MAX_PIXELS // 1_000_000} million pixels")
            probe.verify()
        image = Image.open(io.BytesIO(raw))
        image.load()
    except OverflowError as exc:
        raise ValueError(str(exc)) from exc
    except Image.DecompressionBombError as exc:
        raise ValueError("it would unpack into a picture too large to read safely") from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise ValueError("it is not a picture this page can read") from exc
    actual = {v: k for k, v in PIL_FORMATS.items()}.get(image.format or "")
    if actual is None:
        raise ValueError(f"it is a {image.format or 'file'} picture; use PNG, JPEG, WebP or GIF")
    if actual == "image/gif":
        image.seek(0)
        image = image.convert("RGBA")
        actual = "image/png"
    elif actual != media_type and not (actual == "image/jpeg" and media_type == "image/jpeg"):
        media_type = actual  # the content decides: a PNG named .jpg is sent as a PNG
    if max(image.size) <= MAX_IMAGE_EDGE and actual == media_type and PIL_FORMATS[actual] == image.format:
        return raw, media_type
    image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
    out = io.BytesIO()
    if actual == "image/jpeg":
        image.convert("RGB").save(out, "JPEG", quality=88)
    else:
        image.save(out, PIL_FORMATS[actual])
    return out.getvalue(), actual


class SiteUploads:
    """The waiting uploads, one folder each: the file under its clean name and meta.json describing it.

    Two caps bound what may wait for a message: one for everything together, and a smaller one per caller, keyed on
    an id the page makes for each browser tab. The per-caller cap is about fairness, not security: a caller could
    make up new ids, so the overall cap is what bounds the disk. In a lab on one machine that is the right trade-off;
    a shared deployment would key callers on a signed-in identity instead.
    """

    def __init__(self, root: Path, ttl_s: float = TTL_S, max_waiting_files: int = MAX_WAITING_FILES,
                 max_waiting_bytes: int = MAX_WAITING_BYTES, max_caller_files: int = MAX_CALLER_FILES,
                 max_caller_bytes: int = MAX_CALLER_BYTES):
        self.root, self.ttl_s = root, ttl_s
        self.max_waiting_files, self.max_waiting_bytes = max_waiting_files, max_waiting_bytes
        self.max_caller_files, self.max_caller_bytes = max_caller_files, max_caller_bytes
        self._lock = threading.Lock()

    def _metas(self) -> list[tuple[Path, dict]]:
        out = []
        if not self.root.is_dir():
            return out
        for folder in self.root.iterdir():
            if not folder.is_dir() or not UPLOAD_ID.match(folder.name):
                continue
            try:
                out.append((folder, json.loads((folder / "meta.json").read_text(encoding="utf-8"))))
            except (OSError, ValueError):
                out.append((folder, {"created": folder.stat().st_mtime}))
        return out

    def waiting(self, caller: str | None = None) -> tuple[int, int]:
        """How many uploads are waiting for a message (only those of `caller`, if given) and their total size.
        Expired uploads never count, even before they are pruned."""
        now = time.time()
        count = size = 0
        for _, meta in self._metas():
            if now - meta.get("created", 0) > self.ttl_s or "size" not in meta:
                continue
            if caller is not None and meta.get("caller") != caller:
                continue
            count += 1
            size += int(meta.get("size", 0))
        return count, size

    def save(self, files: list[tuple[str, bytes]], caller: str | None = None) -> list[Upload]:
        """Checks and keeps the files of one upload. All or nothing: one bad file refuses the whole upload, with
        the reason for each. `caller` is the page's id for the browser tab; one that is missing or malformed shares
        the anonymous allowance."""
        caller = caller if caller and CALLER.match(caller) else "anonymous"
        if not files:
            raise ApiError(400, "invalid_request", "Choose at least one file.")
        if len(files) > MAX_FILES:
            raise ApiError(400, "invalid_request", f"Attach at most {MAX_FILES} files at once.")
        ready: list[tuple[str, str, str, bytes]] = []
        problems: list[str] = []
        for raw_name, raw in files:
            name = clean_name(raw_name or "file")
            kind = kind_of(name)
            if kind is None:
                problems.append(f"{name}: attach pictures (PNG, JPEG, WebP, GIF), data or text files (CSV, JSON, "
                                "Markdown, text, HTML, CSS, JavaScript, SVG) or a PDF.")
                continue
            what, media_type = kind
            limit = {"image": MAX_IMAGE_BYTES, "data": MAX_DATA_BYTES, "pdf": MAX_PDF_BYTES}[what]
            if not raw:
                problems.append(f"{name}: the file is empty.")
            elif len(raw) > limit:
                problems.append(f"{name}: {len(raw):,} bytes is over the {limit:,}-byte limit for "
                                + ("a picture." if what == "image" else "a PDF." if what == "pdf" else
                                   "a data file, which is copied into the site and must fit its file limit."))
            elif what == "image":
                try:
                    raw, media_type = checked_image(raw, media_type)
                    ready.append((name, what, media_type, raw))
                except ValueError as exc:
                    problems.append(f"{name}: {exc}.")
            elif what == "pdf":
                if raw[:5] != b"%PDF-":
                    problems.append(f"{name}: it is not a PDF.")
                else:
                    ready.append((name, what, media_type, raw))
            else:
                try:
                    raw.decode("utf-8")
                    ready.append((name, what, media_type, raw))
                except UnicodeDecodeError:
                    problems.append(f"{name}: a data or text file must be UTF-8 text.")
        if problems:
            raise ApiError(400, "invalid_request", " ".join(problems))
        with self._lock:  # prune, count and write together, so two uploads at once cannot both slip under a cap
            self._prune_locked()
            adding = sum(len(raw) for *_, raw in ready)
            mine_count, mine_size = self.waiting(caller)
            if mine_count + len(ready) > self.max_caller_files or mine_size + adding > self.max_caller_bytes:
                raise ApiError(413, "too_large", f"You have too many files waiting to be sent (at most "
                                                 f"{self.max_caller_files} files, {self.max_caller_bytes // 2**20} MB). "
                                                 "Send a message with them, or remove some.")
            count, size = self.waiting()
            if count + len(ready) > self.max_waiting_files or size + adding > self.max_waiting_bytes:
                raise ApiError(413, "too_large", f"Too many files are waiting to be sent (at most "
                                                 f"{self.max_waiting_files} files, {self.max_waiting_bytes // 2**20} MB "
                                                 "in all). Send a message with them, or wait for unused ones to expire.")
            return self._write(ready, caller)

    def _write(self, ready: list[tuple[str, str, str, bytes]], caller: str) -> list[Upload]:
        saved = []
        for name, what, media_type, raw in ready:
            upload_id = secrets.token_hex(16)
            folder = self.root / upload_id
            folder.mkdir(parents=True)
            (folder / name).write_bytes(raw)
            meta = {"name": name, "media_type": media_type, "kind": what, "size": len(raw), "created": time.time(),
                    "caller": caller}
            (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
            saved.append(Upload(upload_id, name, media_type, what, len(raw), folder / name))
        return saved

    def get(self, upload_id: str) -> Upload | None:
        """A waiting upload, or None for an id that is malformed, unknown, used up or expired."""
        if not isinstance(upload_id, str) or not UPLOAD_ID.match(upload_id):
            return None
        folder = self.root / upload_id
        try:
            meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if time.time() - meta.get("created", 0) > self.ttl_s:
            shutil.rmtree(folder, ignore_errors=True)
            return None
        path = folder / meta["name"]
        if not path.is_file() or path.parent != folder:
            return None
        return Upload(upload_id, meta["name"], meta["media_type"], meta["kind"], meta["size"], path)

    def discard(self, upload_id: str) -> None:
        """Deletes an upload once a message has used it."""
        if UPLOAD_ID.match(upload_id):
            shutil.rmtree(self.root / upload_id, ignore_errors=True)

    def prune(self) -> int:
        """Deletes uploads left unused for longer than the time limit. Returns how many it deleted."""
        with self._lock:
            return self._prune_locked()

    def _prune_locked(self) -> int:
        gone = 0
        now = time.time()
        for folder, meta in self._metas():
            if now - meta.get("created", 0) > self.ttl_s:
                shutil.rmtree(folder, ignore_errors=True)
                gone += 1
        return gone
