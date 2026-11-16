"""Which models the /model-failover lab uses, and in what order, kept outside the code so they can be switched live.

A Catalog is an ordered list of ModelEntry (the order is the fallback order) and the compaction model. It is read through a
ModelCatalogRepository, so where it lives can change without touching the lab:
  JsonFileCatalog   config/model-failover.json, checked in. Edit the file and the next model call uses it (the file is checked
                    at most once a second). An edit that is not valid JSON, or breaks a rule, is ignored: the last good
                    catalog stays in use and the error is shown on the page. Saves are atomic (temp file, then rename).
  TableCatalog      Azure Table Storage, keyless (DefaultAzureCredential, or Azurite's development string). One row per
                    model (PartitionKey "model-failover", RowKey = name, an `order` column) and a "_meta" row holding the
                    compaction model. A save is one transaction that checks the ETag of every row, so two writers cannot
                    both win. Reads are cached for MODEL_FAILOVER_CATALOG_TTL_S seconds, so a change made by another
                    instance applies within that time.
  MemoryCatalog     for tests.
Seed the table from the file once:  python -m backend.app.services.model_catalog seed [--force]

A model entry names the model id, its provider (anthropic, azure-openai or local), its context window and, for a GPT
deployment or local model that python/common.py PRICES does not list, its own prices per million tokens. An anthropic entry
must be one of the lab's Claude models (settings.CLAUDE_MODELS) and is always charged at its list price. An azure-openai
entry may use the model "$GPT_DEPLOYMENTS": it stands for every GPT deployment configured in AZURE_OPENAI_DEPLOYMENTS, so
no deployment name is kept in the file. A model that cannot be used here (a deployment that is not configured, no endpoint) is listed as
unavailable with the reason and left out of the router; it is not an error.
Rules, checked on load and on save: names are unique, at least one model is enabled, windows are at least 4000 tokens, the
provider is known, a Claude model is one the lab accepts, every model has a price (in PRICES or its own), and the
compaction model is one of the entries or a known model. No keys are kept anywhere here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import re
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from ..core.errors import ApiError
from ..shared import PRICES, ROOT, is_local, shown_path
from ..settings import CLAUDE_MODELS
from ..settings import MODELS as LAB_MODELS
from ..shared import GPT_MODELS as LAB_GPT_MODELS
from .conversation_store import Conflict, azurite_connection_string
from .model_router import Pool

log = logging.getLogger("llm_lab")

PROVIDERS = ("anthropic", "azure-openai", "local")
GPT_PLACEHOLDER = "$GPT_DEPLOYMENTS"
MIN_WINDOW = 4000
MAX_WINDOW = 10_000_000
MAX_ENTRIES = 12
DEFAULT_PATH = Path("config") / "model-failover.json"
PARTITION = "model-failover"
TABLE = "ModelFailoverCatalog"
META_ROW = "_meta"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
CHECK_EVERY_S = 1.0
DEFAULT_TTL_S = 30.0


class CatalogError(Exception):
    """No usable catalog could be read."""


class CatalogInvalid(CatalogError):
    """The catalog breaks a rule. `problems` lists each one, in plain words."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True)
class ModelEntry:
    """One model in the fallback order. `name` is the id shown on the page and used as the pool name; it defaults to `model`."""
    model: str
    provider: str = "anthropic"
    context_window: int = 200_000
    name: str = ""
    note: str = ""
    enabled: bool = True
    input_per_m: float | None = None  # dollars per million tokens; used only when PRICES has no entry for the model
    output_per_m: float | None = None
    cache_read_per_m: float | None = None

    @property
    def pool_name(self) -> str:
        return self.name or self.model

    @property
    def is_placeholder(self) -> bool:
        return self.model == GPT_PLACEHOLDER

    @property
    def price(self) -> dict[str, float] | None:
        if self.input_per_m is None or self.output_per_m is None:
            return None
        cache = self.cache_read_per_m if self.cache_read_per_m is not None else round(self.input_per_m * 0.1, 6)
        return {"input": self.input_per_m, "output": self.output_per_m, "cache_read": cache}

    def priced(self) -> bool:
        return self.model in PRICES or self.price is not None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"name": self.pool_name if not self.is_placeholder else self.name, "model": self.model,
                               "provider": self.provider, "context_window": self.context_window, "note": self.note,
                               "enabled": self.enabled}
        for key in ("input_per_m", "output_per_m", "cache_read_per_m"):
            if getattr(self, key) is not None:
                out[key] = getattr(self, key)
        return out


@dataclass(frozen=True)
class Catalog:
    entries: tuple[ModelEntry, ...]
    compact_model: str
    version: str = ""
    source: str = ""
    updated_at: str = ""

    def document(self) -> dict[str, Any]:
        """The JSON the file holds (without the version, which is derived)."""
        return {"compact_model": self.compact_model, "models": [e.to_dict() for e in self.entries]}


@dataclass(frozen=True)
class CatalogEnv:
    """What this server can reach: the configured GPT deployments, and whether a local model is set."""
    gpt_models: tuple[str, ...] = ()


@dataclass(frozen=True)
class Resolved:
    """One usable-or-not model after the placeholder is expanded."""
    entry: ModelEntry
    available: bool
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {**self.entry.to_dict(), "name": self.entry.pool_name, "available": self.available, "reason": self.reason}


# ----- parsing and rules -----

def _number(value: Any, what: str, problems: list[str]) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        problems.append(f"{what} must be a number, zero or more.")
        return None
    return float(value)


def build(document: Any, env: CatalogEnv | None = None, *, version: str = "", source: str = "",
          updated_at: str = "") -> Catalog:
    """A Catalog from a decoded JSON document, or CatalogInvalid listing every rule it breaks."""
    env = env or CatalogEnv()
    problems: list[str] = []
    if not isinstance(document, dict):
        raise CatalogInvalid(["The catalog must be an object with `models` and `compact_model`."])
    raw = document.get("models")
    if not isinstance(raw, list) or not raw:
        raise CatalogInvalid(["`models` must be a list with at least one model."])
    if len(raw) > MAX_ENTRIES:
        problems.append(f"At most {MAX_ENTRIES} models.")
    entries: list[ModelEntry] = []
    seen: set[str] = set()
    for i, item in enumerate(raw[:MAX_ENTRIES], 1):
        where = f"Model {i}"
        if not isinstance(item, dict):
            problems.append(f"{where} must be an object.")
            continue
        model, provider = item.get("model"), item.get("provider", "anthropic")
        if not isinstance(model, str) or not model.strip() or len(model) > 120:
            problems.append(f"{where}: `model` must be a model id.")
            continue
        model = model.strip()
        where = f"Model {item.get('name') or model}"
        name = item.get("name") or ""
        if not isinstance(name, str) or (name and not NAME.match(name)):
            problems.append(f"{where}: `name` may use letters, digits and . _ : - (80 at most).")
            name = ""
        if model == GPT_PLACEHOLDER:
            name = ""  # expanded names come from the deployments
        elif not name and not NAME.match(model):
            problems.append(f"{where}: the model id has characters a name cannot use; give it a `name`.")
        if provider not in PROVIDERS:
            problems.append(f"{where}: `provider` must be one of {', '.join(PROVIDERS)}.")
        if model == GPT_PLACEHOLDER and provider != "azure-openai":
            problems.append(f"{where}: {GPT_PLACEHOLDER} needs the provider azure-openai.")
        elif provider == "anthropic" and model not in CLAUDE_MODELS:
            # The lab accepts these Claude ids and no others, as every other route does. Without this a saved entry could
            # send paid calls to any Claude model, at a price of its own choosing (even zero), past the spending cap.
            problems.append(f"{where}: an anthropic model must be one of {', '.join(CLAUDE_MODELS)}.")
        window = item.get("context_window", 200_000)
        if isinstance(window, bool) or not isinstance(window, int) or not MIN_WINDOW <= window <= MAX_WINDOW:
            problems.append(f"{where}: `context_window` must be a whole number from {MIN_WINDOW:,} to {MAX_WINDOW:,}.")
            window = 200_000
        enabled = item.get("enabled", True)
        if not isinstance(enabled, bool):
            problems.append(f"{where}: `enabled` must be true or false.")
            enabled = True
        note = item.get("note", "")
        if not isinstance(note, str) or len(note) > 120:
            problems.append(f"{where}: `note` must be text of 120 characters or fewer.")
            note = ""
        prices = [_number(item.get(k), f"{where}: `{k}`", problems) for k in ("input_per_m", "output_per_m", "cache_read_per_m")]
        if (prices[0] is None) != (prices[1] is None):
            problems.append(f"{where}: give both `input_per_m` and `output_per_m`, or neither.")
        entry = ModelEntry(model, provider if provider in PROVIDERS else "anthropic", window, name, note, enabled, *prices)
        key = entry.pool_name
        if key in seen:
            problems.append(f"{where}: the name {key} is used twice.")
        seen.add(key)
        if provider == "anthropic" and entry.price is not None:
            problems.append(f"{where}: a Claude model is charged at the lab's list price; remove its own prices.")
        if not entry.priced() and not entry.is_placeholder:
            problems.append(f"{where}: no price is known. Give `input_per_m` and `output_per_m` (dollars per million tokens).")
        entries.append(entry)
    compact = document.get("compact_model", "")
    if not isinstance(compact, str) or not compact.strip():
        problems.append("`compact_model` must name a model (a name from the list, or a model id).")
        compact = ""
    if entries and not any(e.enabled for e in entries):
        problems.append("At least one model must be enabled.")
    known = {e.pool_name for e in entries} | {e.model for e in entries} | set(env.gpt_models) | set(PRICES)
    if compact and compact.strip() not in known:
        problems.append(f"`compact_model` {compact.strip()!r} is not one of the models above or a known model.")
    if problems:
        raise CatalogInvalid(problems)
    return Catalog(tuple(entries), compact.strip(), version, source, updated_at)


def resolve(catalog: Catalog, env: CatalogEnv, has_endpoint: bool | None = None) -> list[Resolved]:
    """The entries as the router sees them: the placeholder expanded to the configured deployments, and each marked
    available or not. A model this server cannot reach is unavailable, with the reason, and is not an error."""
    out: list[Resolved] = []
    taken: set[str] = set()
    for entry in catalog.entries:
        if entry.is_placeholder:
            if not env.gpt_models:
                out.append(Resolved(entry, False, "No GPT deployment is configured (AZURE_OPENAI_ENDPOINT and "
                                                  "AZURE_OPENAI_DEPLOYMENTS)."))
                continue
            expanded = [replace(entry, model=d, name=d) for d in env.gpt_models]
        else:
            expanded = [entry]
        for e in expanded:
            reason = ""
            if e.pool_name in taken:
                reason = "Another model already uses this name."
            elif e.provider == "azure-openai" and e.model not in env.gpt_models:
                reason = f"{e.model} is not a configured Azure OpenAI deployment."
            elif e.provider == "local" and not is_local(e.model):
                reason = f"{e.model} is not the local model this server runs (LLM_LAB_LOCAL_MODEL)."
            elif not e.priced():
                reason = "No price is known for this model. Add input_per_m and output_per_m."
            taken.add(e.pool_name)
            out.append(Resolved(e, not reason, reason))
    return out


def hash_version(*parts: str) -> str:
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:12]


# ----- repositories -----

class ModelCatalogRepository(Protocol):
    """Where the catalog lives. `get` is cheap (cached); `save` raises Conflict when `expected_version` is not the current one."""
    kind: str

    def get(self) -> Catalog: ...
    def save(self, catalog: Catalog, expected_version: str) -> Catalog: ...
    def reload(self) -> Catalog: ...
    def describe(self) -> dict[str, Any]: ...


class _Cached:
    """The cache, the last good catalog and the last error, which JsonFileCatalog and TableCatalog share. A subclass supplies
    `_read()` (returns a Catalog, raises CatalogInvalid or CatalogError, or returns None for "unchanged")."""
    kind = ""

    def __init__(self, env: CatalogEnv, interval_s: float, clock: Callable[[], float] = time.monotonic):
        self.env, self.interval_s, self._clock = env, interval_s, clock
        self._lock = threading.RLock()
        self._good: Catalog | None = None
        self._error = ""
        self._checked: float | None = None

    @property
    def last_error(self) -> str:
        return self._error

    def _read(self) -> Catalog | None:
        raise NotImplementedError

    def _refresh(self) -> None:
        try:
            fresh = self._read()
            if fresh is not None:
                self._good, self._error = fresh, ""
        except Exception as exc:  # noqa: BLE001  (a bad edit or a storage hiccup keeps the last good catalog)
            message = "; ".join(exc.problems) if isinstance(exc, CatalogInvalid) else f"{type(exc).__name__}: {exc}"
            if message != self._error:
                log.error("The model catalog could not be read (%s). %s", message,
                          "The last good catalog stays in use." if self._good else "There is no earlier catalog.")
            self._error = message

    def get(self) -> Catalog:
        with self._lock:
            now_ = self._clock()
            if self._good is None or self._checked is None or now_ - self._checked >= self.interval_s:
                self._checked = now_
                self._refresh()
            if self._good is None:
                raise CatalogError(self._error or "The model catalog is empty.")
            return self._good

    def reload(self) -> Catalog:
        with self._lock:
            self._checked = None
            self._forget()
            return self.get()

    def _forget(self) -> None:
        """Make the next read look at the source even if it seems unchanged."""

    def _invalidate(self) -> None:
        self._checked = None
        self._forget()


class JsonFileCatalog(_Cached):
    """config/model-failover.json. Re-read when the file's stamp (modified time, size, inode) changes, checked at most once
    a second, so editing the file switches models without a restart."""
    kind = "file"

    def __init__(self, path: Path, env: CatalogEnv | None = None, check_every_s: float = CHECK_EVERY_S,
                 clock: Callable[[], float] = time.monotonic):
        super().__init__(env or CatalogEnv(), check_every_s, clock)
        self.path = Path(path)
        self._stamp: tuple[int, int, int] | None = None
        self._write_lock = threading.Lock()

    def _forget(self) -> None:
        self._stamp = None

    def _read(self) -> Catalog | None:
        try:
            st = self.path.stat()
        except OSError:
            raise CatalogError(f"{shown_path(self.path)} was not found.") from None
        stamp = (st.st_mtime_ns, st.st_size, st.st_ino)
        if stamp == self._stamp and self._good is not None:
            return None
        self._stamp = stamp  # set first: a bad file is reported once, not on every check
        raw = self.path.read_bytes()
        try:
            document = json.loads(raw.decode("utf-8"))
        except ValueError as exc:
            raise CatalogInvalid([f"The file is not valid JSON: {exc}"]) from None
        stamped = datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(timespec="seconds")
        return build(document, self.env, version=hash_version(raw.decode("utf-8")), source=shown_path(self.path), updated_at=stamped)

    def _disk_version(self) -> str:
        try:
            return hash_version(self.path.read_text(encoding="utf-8"))
        except OSError:
            return ""

    def save(self, catalog: Catalog, expected_version: str) -> Catalog:
        checked = build(catalog.document(), self.env)  # the rules apply to every save
        text = json.dumps(checked.document(), indent=2, ensure_ascii=False) + "\n"
        with self._write_lock:
            with self._lock:
                self._invalidate()
                try:
                    self.get()
                except CatalogError:
                    pass
                on_disk = self._disk_version()
                good = self._good.version if self._good else ""
                # A file that is currently broken may be repaired by saving over the last good version.
                if expected_version != on_disk and not (self._error and expected_version == good):
                    raise Conflict("The file changed since it was read.")
                self.path.parent.mkdir(parents=True, exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name + ".", suffix=".tmp")
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as handle:
                        handle.write(text)
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.replace(tmp, self.path)
                except BaseException:
                    Path(tmp).unlink(missing_ok=True)
                    raise
                self._invalidate()
                return self.get()

    def describe(self) -> dict[str, Any]:
        return {"kind": self.kind, "where": shown_path(self.path), "check_every_s": self.interval_s}


class MemoryCatalog(_Cached):
    """For tests: the same rules, kept in memory."""
    kind = "memory"

    def __init__(self, document: dict[str, Any], env: CatalogEnv | None = None):
        super().__init__(env or CatalogEnv(), 0.0)
        self._n = 1
        self._doc = document
        self._stamp: int | None = None

    def _read(self) -> Catalog | None:
        return build(self._doc, self.env, version=f"m{self._n}", source="memory", updated_at=now())

    def set_document(self, document: dict[str, Any]) -> None:
        """Replace the document without validation (a test's way of making a bad edit)."""
        with self._lock:
            self._doc, self._n = document, self._n + 1

    def save(self, catalog: Catalog, expected_version: str) -> Catalog:
        checked = build(catalog.document(), self.env)
        with self._lock:
            if expected_version != f"m{self._n}":
                raise Conflict("The catalog changed since it was read.")
            self._doc, self._n = checked.document(), self._n + 1
            return self.get()

    def describe(self) -> dict[str, Any]:
        return {"kind": self.kind, "where": "memory"}


class TableCatalog(_Cached):
    """Azure Table Storage (or Azurite): a row per model and a meta row. The version is a hash of every row's ETag, and a
    save is one transaction that checks all of them."""
    kind = "table"

    def __init__(self, table_service: Any, env: CatalogEnv | None = None, ttl_s: float = DEFAULT_TTL_S, where: str = "",
                 table: str = TABLE, clock: Callable[[], float] = time.monotonic):
        super().__init__(env or CatalogEnv(), ttl_s, clock)
        self._service, self.table, self._where, self._ready = table_service, table, where, False

    def _client(self) -> Any:
        if not self._ready:
            self._service.create_table_if_not_exists(self.table)
            self._ready = True
        return self._service.get_table_client(self.table)

    def _rows(self) -> list[Any]:
        return list(self._client().query_entities("PartitionKey eq @p", parameters={"p": PARTITION}))

    @staticmethod
    def _entry(row: Any) -> ModelEntry:
        get = row.get
        return ModelEntry(get("model", ""), get("provider", "anthropic"), int(get("contextWindow", 200_000)),
                          row["RowKey"] if row["RowKey"] != get("model", "") else "", get("note", ""),
                          bool(get("enabled", True)), get("inputPerM"), get("outputPerM"), get("cacheReadPerM"))

    def _read(self) -> Catalog | None:
        rows = self._rows()
        meta = next((r for r in rows if r["RowKey"] == META_ROW), None)
        pools = sorted((r for r in rows if r["RowKey"] != META_ROW), key=lambda r: (int(r.get("order", 0)), r["RowKey"]))
        if meta is None or not pools:
            raise CatalogError(f"The table {self.table} has no catalog yet. Seed it from the JSON file: "
                               "python -m backend.app.services.model_catalog seed")
        version = hash_version(*[f"{r['RowKey']}={r.metadata['etag']}" for r in sorted(rows, key=lambda r: r["RowKey"])])
        document = {"compact_model": meta.get("compactModel", ""), "models": [self._entry(r).to_dict() for r in pools]}
        # The name column is the RowKey; an entry whose name equals its model has no separate name.
        stamp = meta.metadata.get("timestamp") if hasattr(meta, "metadata") else None
        stamped = stamp.isoformat(timespec="seconds") if hasattr(stamp, "isoformat") else now()
        return build(document, self.env, version=version, source=f"{self._where}/{self.table}", updated_at=stamped)

    def save(self, catalog: Catalog, expected_version: str) -> Catalog:
        from azure.core import MatchConditions
        from azure.core.exceptions import HttpResponseError, ResourceExistsError
        from azure.data.tables import TableTransactionError
        checked = build(catalog.document(), self.env)
        with self._lock:
            client = self._client()
            rows = self._rows()
            current = hash_version(*[f"{r['RowKey']}={r.metadata['etag']}" for r in sorted(rows, key=lambda r: r["RowKey"])]) \
                if rows else ""
            if expected_version != current:
                raise Conflict("The table changed since it was read.")
            existing = {r["RowKey"]: r.metadata["etag"] for r in rows}

            def op(kind: str, entity: dict[str, Any]) -> tuple:
                key = entity["RowKey"]
                if key in existing:
                    cond = {"etag": existing[key], "match_condition": MatchConditions.IfNotModified}
                    return (kind, entity, {"mode": "replace", **cond}) if kind == "update" else ("delete", entity, cond)
                return ("create", entity)

            meta = {"PartitionKey": PARTITION, "RowKey": META_ROW, "compactModel": checked.compact_model}
            ops: list[tuple] = [op("update", meta)]
            for order, e in enumerate(checked.entries):
                ops.append(op("update", self._row(e, order)))
            for key in existing:
                if key != META_ROW and key not in {e.pool_name for e in checked.entries}:
                    ops.append(op("delete", {"PartitionKey": PARTITION, "RowKey": key}))
            try:
                client.submit_transaction(ops)
            except ResourceExistsError as exc:
                raise Conflict("The table changed since it was read.") from exc
            except (HttpResponseError, TableTransactionError) as exc:
                if getattr(exc, "status_code", None) in (409, 412):
                    raise Conflict("The table changed since it was read.") from exc
                raise
            self._invalidate()
            return self.get()

    @staticmethod
    def _row(e: ModelEntry, order: int) -> dict[str, Any]:
        row: dict[str, Any] = {"PartitionKey": PARTITION, "RowKey": e.pool_name, "order": order, "model": e.model,
                               "provider": e.provider, "contextWindow": e.context_window, "note": e.note,
                               "enabled": e.enabled}
        for column, value in (("inputPerM", e.input_per_m), ("outputPerM", e.output_per_m),
                              ("cacheReadPerM", e.cache_read_per_m)):
            if value is not None:
                row[column] = value
        return row

    def describe(self) -> dict[str, Any]:
        return {"kind": self.kind, "where": self._where, "table": self.table, "ttl_s": self.interval_s}


def table_catalog_from_settings(settings: Any, env: CatalogEnv, credential: Any = None) -> TableCatalog:
    """Table Storage as the history store does it: signed in with DefaultAzureCredential (no keys) for an account or
    endpoint, or Azurite's development connection string for a local test. Nothing else is accepted."""
    from azure.data.tables import TableServiceClient
    ttl = settings.model_failover_catalog_ttl_s
    if settings.model_failover_storage_account or settings.model_failover_table_endpoint:
        from azure.identity import DefaultAzureCredential
        url = settings.model_failover_table_endpoint or f"https://{settings.model_failover_storage_account}.table.core.windows.net"
        service = TableServiceClient(endpoint=url, credential=credential or DefaultAzureCredential())
        return TableCatalog(service, env, ttl, url)
    if settings.model_failover_storage_connection_string:
        service = TableServiceClient.from_connection_string(azurite_connection_string(settings.model_failover_storage_connection_string))
        return TableCatalog(service, env, ttl, "Azurite on this machine (127.0.0.1:10002)")
    raise ValueError("MODEL_FAILOVER_CATALOG=table needs MODEL_FAILOVER_STORAGE_ACCOUNT (or MODEL_FAILOVER_TABLE_ENDPOINT), "
                     "or Azurite's development connection string in MODEL_FAILOVER_STORAGE_CONNECTION_STRING.")


def seed_table(table: TableCatalog, path: Path, force: bool = False) -> Catalog:
    """Copies the JSON file into the table. Refuses when the table already has a catalog, unless `force`."""
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    wanted = build(document, table.env)
    try:
        current = table.reload()
    except CatalogError:
        return table.save(wanted, "")
    if not force:
        raise CatalogError("The table already has a catalog. Use --force to replace it.")
    return table.save(wanted, current.version)


def catalog_env(settings: Any) -> CatalogEnv:
    """The GPT deployments this server can call: the same filter the other labs use."""
    if not settings.azure_openai_endpoint:
        return CatalogEnv()
    return CatalogEnv(tuple(d for d in settings.azure_openai_deployments if d.startswith("gpt-") and "image" not in d))


def catalog_path(settings: Any) -> Path:
    path = Path(settings.model_failover_catalog_path)
    return path if path.is_absolute() else ROOT / path


def repository_from_settings(settings: Any, env: CatalogEnv) -> ModelCatalogRepository:
    if settings.model_failover_catalog == "table":
        return table_catalog_from_settings(settings, env)
    return JsonFileCatalog(catalog_path(settings), env)


# ----- what the lab uses -----

class ModelCatalog:
    """The repository plus this server's environment: pools for the router, the compaction model, and the page's view."""

    def __init__(self, repo: ModelCatalogRepository, env: CatalogEnv | None = None):
        self.repo, self.env = repo, env or getattr(repo, "env", CatalogEnv())
        self._lock = threading.Lock()
        self._memo: tuple[str, list[Pool]] | None = None
        self.pool_error = ""

    def source(self) -> tuple[str, list[Pool]]:
        """(version, pools) for the router: the enabled and available models, in order."""
        catalog = self.repo.get()
        with self._lock:
            if self._memo and self._memo[0] == catalog.version:
                return self._memo
            pools = [Pool(r.entry.pool_name, r.entry.model, r.entry.provider, r.entry.context_window, r.entry.note,
                          r.entry.price)
                     for r in resolve(catalog, self.env) if r.available and r.entry.enabled]
            if not pools:
                self.pool_error = "No model in the catalog is both enabled and available."
                raise CatalogError(self.pool_error)
            self.pool_error = ""
            self._memo = (catalog.version, pools)
            return self._memo

    def compact_model(self) -> str:
        return self.repo.get().compact_model

    def known_models(self) -> list[str]:
        """The chat models the lab accepts (as everywhere else: the local model, current Claude, this server's GPT
        chat deployments). Not every priced model: an image or embedding model would fail as a chat pool."""
        names = [m for m in LAB_MODELS if m not in LAB_GPT_MODELS]  # the GPT part comes from this server's settings
        return names + [d for d in self.env.gpt_models if d not in names] + [GPT_PLACEHOLDER]

    def payload(self) -> dict[str, Any]:
        """What GET /catalog returns."""
        try:
            catalog = self.repo.get()
        except CatalogError as exc:
            return {"entries": [], "resolved": [], "compact_model": "", "version": "", "updated_at": "",
                    "source": self.repo.describe(), "error": str(exc), "known_models": self.known_models(),
                    "providers": list(PROVIDERS), "placeholder": GPT_PLACEHOLDER, "min_window": MIN_WINDOW}
        resolved = resolve(catalog, self.env)
        error = self.repo.last_error if hasattr(self.repo, "last_error") else ""
        if not error:
            try:
                self.source()
            except CatalogError as exc:
                error = str(exc)
        return {"entries": [e.to_dict() for e in catalog.entries], "resolved": [r.to_dict() for r in resolved],
                "compact_model": catalog.compact_model, "version": catalog.version, "updated_at": catalog.updated_at,
                "source": self.repo.describe(), "error": error, "known_models": self.known_models(),
                "providers": list(PROVIDERS), "placeholder": GPT_PLACEHOLDER, "min_window": MIN_WINDOW}

    def save(self, document: dict[str, Any], version: str) -> dict[str, Any]:
        """Validates and saves. 400 for a rule broken, 409 for a stale version."""
        try:
            catalog = build(document, self.env)
            self.repo.save(catalog, version)
        except CatalogInvalid as exc:
            raise ApiError(400, "invalid_catalog", " ".join(exc.problems)) from None
        except Conflict:
            raise ApiError(409, "stale_catalog", "The model list changed since you loaded it. Reload it and try again.") from None
        except CatalogError as exc:
            raise ApiError(503, "model_catalog_unavailable", str(exc)) from None
        return self.payload()

    def reload(self) -> dict[str, Any]:
        try:
            self.repo.reload()
        except CatalogError:
            pass  # the payload reports it
        return self.payload()


def main(argv: list[str] | None = None) -> int:
    from ..settings import Settings
    parser = argparse.ArgumentParser(description="Copy config/model-failover.json into the Table Storage catalog.")
    parser.add_argument("command", choices=["seed"])
    parser.add_argument("--force", action="store_true", help="replace a catalog that is already in the table")
    parser.add_argument("--file", type=Path, default=None, help="the JSON file (default: MODEL_FAILOVER_CATALOG_PATH)")
    args = parser.parse_args(argv)
    settings = Settings.from_env()
    table = table_catalog_from_settings(settings, catalog_env(settings))
    try:
        done = seed_table(table, args.file or catalog_path(settings), args.force)
    except CatalogError as exc:
        print(exc)
        return 1
    print(f"Seeded {len(done.entries)} models into {table.describe()['where']} / {table.table} (version {done.version}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
