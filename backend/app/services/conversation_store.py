"""The lab's own record of a conversation: the model holds no state, so everything the next model needs is read from here.

The canonical shape. A conversation is an ordered list of Steps. A Step is one user message, one model call, one tool
result or one stored summary, and its `content` is a list of Claude Messages-shaped content blocks (text, tool_use,
tool_result, and the provider-specific thinking and redacted_thinking blocks). That is the shape the coding agent already
keeps its history in. A block is kept in the store exactly as the model sent it, so nothing is lost when a conversation
moves between models. What a provider cannot take is removed only when a request is built for it (model_failover.py
strips thinking blocks for another provider and turns the rest into Chat Completions messages through gpt_model.to_chat).
Each step also records which model answered, through which provider, what it fell back from and why, its tokens and its
latency, so the page can show every step's model and the log can be audited.

Layout, the same in every implementation:
  Blob   conversations/{user}/{conv}/steps/{turn:06d}-{step:02d}.json    one immutable JSON document per step
  Table  Conversations   PartitionKey=user, RowKey=conv                  title, status, lastStep, updatedAt (the ETag fence)
  Table  Steps           PartitionKey=conv, RowKey={turn:06d}-{step:02d} blobPath, model, provider, fallbackFrom, reason,
                                                                         tokens, latencyMs (an index: no content)

Writing a step. `append_step` takes the ETag the writer last saw. (1) The Conversation row is replaced with
lastStep set to the new step, with If-Match on that ETag: two writers holding the same ETag cannot both win, and the
loser gets Conflict with nothing written. (2) The step's blob is written. (3) Its Steps row is written. A crash between
(1) and (3) leaves a Conversation row that points at a step with no blob or row; `load` reports the last complete step
instead, without writing (a writer may be between (1) and (3) right now), so a run resumes from the last complete step.

Compaction never deletes. A summary is one more step (kind "summary", with the range it covers and the model that wrote
it) written with the same ETag rule, so two writers cannot both compact. The steps it covers stay in Blob as the audit
trail; only what is sent to a model changes.

Implementations: BlobTableStore (Azure Blob and Table Storage, or Azurite), FileStore (the same layout in files under
generated/model-failover/, for when nothing is configured) and MemoryStore (tests). They share _LayeredStore, which holds
the rules above; each only supplies a few storage primitives. SqlStore is the design for later and is not implemented.

SqlStore design note (SQL Server or Azure SQL, later, behind the same ConversationStore interface):
  Conversations(ConvId char(12) PK, UserId nvarchar(64) index, Title, Status, LastStep, UpdatedAt datetime2, Overrides json,
                RowVersion rowversion)           -- RowVersion is the ETag; UPDATE ... WHERE ConvId=@id AND RowVersion=@v
  Steps(ConvId, Turn int, Step int, PK(ConvId, Turn, Step), Kind, Role, Model, Provider, FallbackFrom, Reason, CoversFrom, CoversUntil,
        InputTokens, OutputTokens, LatencyMs, CreatedAt, Content nvarchar(max) CHECK (ISJSON(Content) = 1))
  Content stays in a JSON column while steps are small; move it to Blob (keeping BlobPath) when they are not.
  append_step is one transaction: update Conversations by RowVersion (zero rows affected means Conflict), insert the
  Steps row. There is no torn write to repair, so load() needs no repair step. The agent never changes.
No keys are kept here. Azure Storage is signed in to with DefaultAzureCredential; the only connection string accepted
is Azurite's published development one (devstoreaccount1), for a local test.
"""
from __future__ import annotations

import json
import re
import threading
import uuid
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

USER = "lab"  # the lab has no sign-in: one user. A product reads it from the verified session.
CONTAINER = "model-failover"
CONVERSATIONS_TABLE = "ModelFailoverConversations"
STEPS_TABLE = "ModelFailoverSteps"
ID = re.compile(r"^[0-9a-f]{12}$")
SAFE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
KINDS = ("user", "model", "tool", "summary")


class Conflict(Exception):
    """The writer's ETag is stale: someone else changed the conversation since it was read. Nothing was written."""


class NotFound(KeyError):
    """No such conversation."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def key_order(key: str) -> tuple[int, int]:
    """A step key ({turn:06d}-{step:02d}) as numbers, for comparing. As text, a 100th step would sort before the 99th."""
    turn, _, step = key.partition("-")
    return int(turn), int(step)


@dataclass
class Step:
    """One user message, model call, tool result or summary, in the canonical (Claude Messages) shape plus metadata."""
    turn: int
    step: int
    kind: str  # user | model | tool | summary
    role: str  # user | assistant (a tool result and a summary are sent as user messages)
    content: list[dict[str, Any]]
    model: str = ""  # the model that produced a model step
    provider: str = ""  # anthropic | azure-openai
    fallback_from: str = ""  # the model that was tried first and failed, or was skipped because its breaker was open
    reason: str = ""  # why: "429, retry-after 30 s", "breaker open", ...
    stop_reason: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0
    created_at: str = ""
    tool: str = ""  # tool steps: the name of the tool that ran
    covers_from: str = ""  # summary only: the key of the first step this summary stands in for
    covers_until: str = ""  # summary only: the key of the last step this summary stands in for
    blob_path: str = ""

    @property
    def key(self) -> str:
        return f"{self.turn:06d}-{self.step:02d}"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Step":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class Conversation:
    id: str
    user_id: str
    title: str = ""
    status: str = "idle"  # idle | running | failed
    last_step: str = ""
    created_at: str = ""
    updated_at: str = ""
    etag: str = ""
    steps: list[Step] = field(default_factory=list)
    overrides: dict[str, Any] = field(default_factory=dict)  # this conversation's compaction settings (the lab's choice)

    def summary(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "status": self.status, "last_step": self.last_step,
                "created_at": self.created_at, "updated_at": self.updated_at}


def blob_path(user_id: str, conv_id: str, key: str) -> str:
    return f"conversations/{user_id}/{conv_id}/steps/{key}.json"


class ConversationStore(Protocol):
    """Everything the agent needs from a history store. Implementations differ in where bytes live, not in rules."""
    kind: str

    def create(self, user_id: str = USER, conv_id: str | None = None) -> Conversation: ...
    def load(self, conv_id: str, user_id: str | None = None) -> Conversation: ...
    def append_step(self, conv_id: str, step: Step, expected_etag: str, user_id: str | None = None) -> str: ...
    def update_meta(self, conv_id: str, expected_etag: str, *, status: str | None = None, title: str | None = None,
                    overrides: dict[str, Any] | None = None, user_id: str | None = None) -> str: ...
    def list(self, user_id: str = USER) -> list[Conversation]: ...
    def delete(self, conv_id: str, user_id: str | None = None) -> None: ...
    def describe(self) -> dict[str, Any]: ...


class _LayeredStore(ABC):
    """The rules of the layout, written once. A subclass supplies where the blobs, conversation rows and step rows live.

    Conversation rows are dicts with PartitionKey, RowKey, title, status, lastStep, createdAt, updatedAt; the primitives
    add the ETag. Step rows are dicts with PartitionKey (the conversation), RowKey (the step key) and the index fields.
    """
    kind = "memory"

    # ----- primitives -----

    @abstractmethod
    def _blob_put(self, path: str, data: str) -> None: ...
    @abstractmethod
    def _blob_get(self, path: str) -> str: ...
    @abstractmethod
    def _blob_delete_prefix(self, prefix: str) -> None: ...
    @abstractmethod
    def _blob_paths(self, prefix: str) -> list[str]: ...
    @abstractmethod
    def _conv_insert(self, row: dict[str, Any]) -> str: ...
    @abstractmethod
    def _conv_get(self, user_id: str | None, conv_id: str) -> tuple[dict[str, Any], str] | None: ...
    @abstractmethod
    def _conv_replace(self, row: dict[str, Any], etag: str) -> str: ...  # raises Conflict when etag is stale
    @abstractmethod
    def _conv_delete(self, row: dict[str, Any]) -> None: ...
    @abstractmethod
    def _conv_list(self, user_id: str) -> list[tuple[dict[str, Any], str]]: ...
    @abstractmethod
    def _step_put(self, row: dict[str, Any]) -> None: ...
    @abstractmethod
    def _step_rows(self, conv_id: str) -> list[dict[str, Any]]: ...  # in RowKey order
    @abstractmethod
    def _step_delete_all(self, conv_id: str) -> None: ...

    # ----- the interface -----

    def create(self, user_id: str = USER, conv_id: str | None = None) -> Conversation:
        """A new conversation. A caller that already has an id for it (a framework's session id) passes conv_id."""
        if not SAFE.match(user_id) or (conv_id is not None and not ID.match(conv_id)):
            raise ValueError("The user id may hold letters, digits, - and _ only, and a conversation id is 12 hex digits.")
        stamp = now()
        conv_id = conv_id or uuid.uuid4().hex[:12]
        row = {"PartitionKey": user_id, "RowKey": conv_id, "title": "", "status": "idle", "lastStep": "",
               "createdAt": stamp, "updatedAt": stamp, "overrides": "{}"}
        etag = self._conv_insert(row)
        return Conversation(conv_id, user_id, "", "idle", "", stamp, stamp, etag)

    def _row(self, conv_id: str, user_id: str | None) -> tuple[dict[str, Any], str]:
        found = self._conv_get(user_id, conv_id) if ID.match(conv_id or "") else None
        if found is None:
            raise NotFound(conv_id)
        return found

    def load(self, conv_id: str, user_id: str | None = None) -> Conversation:
        row, etag = self._row(conv_id, user_id)
        user = row["PartitionKey"]
        index = self._step_rows(conv_id)
        steps: list[Step] = []
        for entry in index:  # a row is written after its blob, so a row always has its blob
            steps.append(Step.from_dict(json.loads(self._blob_get(entry["blobPath"]))))
        steps.sort(key=lambda s: (s.turn, s.step))  # the stores list keys as text, where step 100 comes before 99
        # The last whole step, whatever the row says. A row pointing past it is either a writer part way through a step
        # (row claimed, blob not yet written) or one that crashed there. Reading never writes: a repair here would move the
        # ETag a running writer holds and fail its next step. The next append_step sets lastStep again either way.
        complete = steps[-1].key if steps else ""
        return Conversation(conv_id, user, row.get("title", ""), row.get("status", "idle"), complete,
                            row.get("createdAt", ""), row.get("updatedAt", ""), etag, steps,
                            json.loads(row.get("overrides") or "{}"))

    def append_step(self, conv_id: str, step: Step, expected_etag: str, user_id: str | None = None) -> str:
        if step.kind not in KINDS or step.turn < 0 or step.step < 0:
            raise ValueError("A step needs a known kind and a turn and step number from zero.")
        row, etag = self._row(conv_id, user_id)
        if etag != expected_etag:
            raise Conflict(f"The conversation changed since it was read (ETag {expected_etag} is stale).")
        user = row["PartitionKey"]
        step.created_at = step.created_at or now()
        step.blob_path = blob_path(user, conv_id, step.key)
        title = row.get("title", "")
        if not title and step.kind == "user":
            title = " ".join(b.get("text", "") for b in step.content if b.get("type") == "text").strip()[:60]
        claimed = {**row, "title": title, "status": "running", "lastStep": step.key, "updatedAt": step.created_at}
        new_etag = self._conv_replace(claimed, etag)  # the commit point: Conflict here means nothing was written
        self._blob_put(step.blob_path, json.dumps(step.to_dict(), ensure_ascii=False))
        self._step_put({"PartitionKey": conv_id, "RowKey": step.key, "blobPath": step.blob_path, "kind": step.kind,
                        "model": step.model, "provider": step.provider, "fallbackFrom": step.fallback_from,
                        "reason": step.reason, "inputTokens": step.input_tokens, "outputTokens": step.output_tokens,
                        "latencyMs": step.latency_ms})
        return new_etag

    def update_meta(self, conv_id: str, expected_etag: str, *, status: str | None = None, title: str | None = None,
                    overrides: dict[str, Any] | None = None, user_id: str | None = None) -> str:
        row, etag = self._row(conv_id, user_id)
        if etag != expected_etag:
            raise Conflict("The conversation changed since it was read.")
        row = {**row, "status": status or row.get("status", "idle"), "title": row.get("title", "") if title is None else title,
               "updatedAt": now()}
        if overrides is not None:
            row["overrides"] = json.dumps(overrides)
        return self._conv_replace(row, etag)

    def list(self, user_id: str = USER) -> list[Conversation]:
        out = [Conversation(r["RowKey"], r["PartitionKey"], r.get("title", ""), r.get("status", "idle"),
                            r.get("lastStep", ""), r.get("createdAt", ""), r.get("updatedAt", ""), etag)
               for r, etag in self._conv_list(user_id)]
        return sorted(out, key=lambda c: c.updated_at, reverse=True)

    def delete(self, conv_id: str, user_id: str | None = None) -> None:
        row, _ = self._row(conv_id, user_id)
        self._blob_delete_prefix(f"conversations/{row['PartitionKey']}/{conv_id}/")
        self._step_delete_all(conv_id)
        self._conv_delete(row)

    # ----- for the page's storage panel -----

    def rows(self, conv_id: str, user_id: str | None = None) -> dict[str, Any]:
        """Where the conversation's data lives: its blob paths and its table rows, as stored."""
        row, etag = self._row(conv_id, user_id)
        return {"conversation_row": {**row, "etag": etag}, "step_rows": self._step_rows(conv_id),
                "blobs": self._blob_paths(f"conversations/{row['PartitionKey']}/{conv_id}/")}

    def describe(self) -> dict[str, Any]:
        return {"kind": self.kind, "where": "memory"}


class MemoryStore(_LayeredStore):
    """Everything in dicts, for tests. Thread-safe, with the same ETag rules as the others."""
    kind = "memory"

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._blobs: dict[str, str] = {}
        self._convs: dict[tuple[str, str], tuple[dict[str, Any], int]] = {}
        self._steps: dict[str, dict[str, dict[str, Any]]] = {}

    def _blob_put(self, path: str, data: str) -> None:
        with self._lock:
            self._blobs[path] = data

    def _blob_get(self, path: str) -> str:
        with self._lock:
            return self._blobs[path]

    def _blob_delete_prefix(self, prefix: str) -> None:
        with self._lock:
            for p in [p for p in self._blobs if p.startswith(prefix)]:
                del self._blobs[p]

    def _blob_paths(self, prefix: str) -> list[str]:
        with self._lock:
            return sorted(p for p in self._blobs if p.startswith(prefix))

    @staticmethod
    def _tag(version: int) -> str:
        return f'W/"{version}"'

    def _conv_insert(self, row: dict[str, Any]) -> str:
        with self._lock:
            self._convs[(row["PartitionKey"], row["RowKey"])] = (dict(row), 1)
            return self._tag(1)

    def _conv_get(self, user_id: str | None, conv_id: str) -> tuple[dict[str, Any], str] | None:
        with self._lock:
            for (user, conv), (row, version) in self._convs.items():
                if conv == conv_id and user_id in (None, user):
                    return dict(row), self._tag(version)
        return None

    def _conv_replace(self, row: dict[str, Any], etag: str) -> str:
        with self._lock:
            key = (row["PartitionKey"], row["RowKey"])
            if key not in self._convs:
                raise NotFound(row["RowKey"])
            version = self._convs[key][1]
            if self._tag(version) != etag:
                raise Conflict("stale ETag")
            self._convs[key] = (dict(row), version + 1)
            return self._tag(version + 1)

    def _conv_delete(self, row: dict[str, Any]) -> None:
        with self._lock:
            self._convs.pop((row["PartitionKey"], row["RowKey"]), None)

    def _conv_list(self, user_id: str) -> list[tuple[dict[str, Any], str]]:
        with self._lock:
            return [(dict(r), self._tag(v)) for (u, _), (r, v) in self._convs.items() if u == user_id]

    def _step_put(self, row: dict[str, Any]) -> None:
        with self._lock:
            self._steps.setdefault(row["PartitionKey"], {})[row["RowKey"]] = dict(row)

    def _step_rows(self, conv_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for _, r in sorted(self._steps.get(conv_id, {}).items())]

    def _step_delete_all(self, conv_id: str) -> None:
        with self._lock:
            self._steps.pop(conv_id, None)


class FileStore(_LayeredStore):
    """The same layout in files, for a lab with no Azure: blobs at root/conversations/..., rows as JSON files under
    root/tables/. A lock makes the ETag check and the write one step inside this process (the lab runs one backend)."""
    kind = "files"

    def __init__(self, root: Path):
        self.root = Path(root)
        self._lock = threading.RLock()

    def _safe(self, relative: str) -> Path:
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root.resolve()):
            raise ValueError("Path outside the store.")
        return path

    def _write(self, path: Path, data: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + f".{uuid.uuid4().hex[:6]}.tmp")
        tmp.write_text(data, encoding="utf-8")
        tmp.replace(path)  # a reader never sees half a file

    def _blob_put(self, path: str, data: str) -> None:
        self._write(self._safe(path), data)

    def _blob_get(self, path: str) -> str:
        return self._safe(path).read_text(encoding="utf-8")

    def _blob_delete_prefix(self, prefix: str) -> None:
        import shutil
        folder = self._safe(prefix.rstrip("/"))
        if folder.is_dir():
            shutil.rmtree(folder)

    def _blob_paths(self, prefix: str) -> list[str]:
        folder = self._safe(prefix.rstrip("/"))
        return sorted(p.relative_to(self.root).as_posix() for p in folder.rglob("*.json")) if folder.is_dir() else []

    def _conv_path(self, user: str, conv: str) -> Path:
        return self._safe(f"tables/{CONVERSATIONS_TABLE}/{user}/{conv}.json")

    def _read_conv(self, path: Path) -> tuple[dict[str, Any], str]:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data["row"], f'W/"{data["version"]}"'

    def _conv_insert(self, row: dict[str, Any]) -> str:
        with self._lock:
            self._write(self._conv_path(row["PartitionKey"], row["RowKey"]), json.dumps({"row": row, "version": 1}))
            return 'W/"1"'

    def _conv_get(self, user_id: str | None, conv_id: str) -> tuple[dict[str, Any], str] | None:
        with self._lock:
            base = self._safe(f"tables/{CONVERSATIONS_TABLE}")
            for path in base.glob(f"{user_id or '*'}/{conv_id}.json"):
                return self._read_conv(path)
        return None

    def _conv_replace(self, row: dict[str, Any], etag: str) -> str:
        with self._lock:
            path = self._conv_path(row["PartitionKey"], row["RowKey"])
            if not path.exists():
                raise NotFound(row["RowKey"])
            current = json.loads(path.read_text(encoding="utf-8"))
            if f'W/"{current["version"]}"' != etag:
                raise Conflict("stale ETag")
            self._write(path, json.dumps({"row": row, "version": current["version"] + 1}))
            return f'W/"{current["version"] + 1}"'

    def _conv_delete(self, row: dict[str, Any]) -> None:
        with self._lock:
            self._conv_path(row["PartitionKey"], row["RowKey"]).unlink(missing_ok=True)

    def _conv_list(self, user_id: str) -> list[tuple[dict[str, Any], str]]:
        with self._lock:
            base = self._safe(f"tables/{CONVERSATIONS_TABLE}/{user_id}")
            return [self._read_conv(p) for p in sorted(base.glob("*.json"))] if base.is_dir() else []

    def _step_put(self, row: dict[str, Any]) -> None:
        self._write(self._safe(f"tables/{STEPS_TABLE}/{row['PartitionKey']}/{row['RowKey']}.json"), json.dumps(row))

    def _step_rows(self, conv_id: str) -> list[dict[str, Any]]:
        base = self._safe(f"tables/{STEPS_TABLE}/{conv_id}")
        return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(base.glob("*.json"))] if base.is_dir() else []

    def _step_delete_all(self, conv_id: str) -> None:
        import shutil
        base = self._safe(f"tables/{STEPS_TABLE}/{conv_id}")
        if base.is_dir():
            shutil.rmtree(base)

    def describe(self) -> dict[str, Any]:
        return {"kind": self.kind, "where": str(self.root)}


class BlobTableStore(_LayeredStore):
    """Azure Blob Storage for the step documents and Azure Table Storage for the index and the ETag fence.

    The Conversation row's ETag is Table Storage's own, checked with If-Match. Tables and the container are created on
    first use. Build it with `blob_table_store`, which signs in with DefaultAzureCredential (no keys) or, for a local
    test, uses Azurite.
    """

    def __init__(self, blob_service: Any, table_service: Any, kind: str = "azure", where: str = ""):
        self.kind, self._where = kind, where
        self._blob_service, self._table_service = blob_service, table_service
        self._ready = False
        self._lock = threading.Lock()

    def _setup(self) -> None:
        with self._lock:
            if self._ready:
                return
            from azure.core.exceptions import ResourceExistsError
            try:
                self._blob_service.create_container(CONTAINER)
            except ResourceExistsError:
                pass
            self._table_service.create_table_if_not_exists(CONVERSATIONS_TABLE)
            self._table_service.create_table_if_not_exists(STEPS_TABLE)
            self._ready = True

    @property
    def _container(self) -> Any:
        self._setup()
        return self._blob_service.get_container_client(CONTAINER)

    def _table(self, name: str) -> Any:
        self._setup()
        return self._table_service.get_table_client(name)

    @staticmethod
    def _entity(row: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in row.items() if k not in ("etag",)}

    @staticmethod
    def _clean(entity: Any) -> dict[str, Any]:
        return {k: v for k, v in dict(entity).items() if k not in ("Timestamp", "etag")}

    @staticmethod
    def _etag(entity: Any) -> str:
        return entity.metadata["etag"]

    def _blob_put(self, path: str, data: str) -> None:
        self._container.upload_blob(path, data.encode("utf-8"), overwrite=True)

    def _blob_get(self, path: str) -> str:
        return self._container.download_blob(path).readall().decode("utf-8")

    def _blob_delete_prefix(self, prefix: str) -> None:
        container = self._container
        for blob in list(container.list_blobs(name_starts_with=prefix)):
            container.delete_blob(blob.name)

    def _blob_paths(self, prefix: str) -> list[str]:
        return sorted(b.name for b in self._container.list_blobs(name_starts_with=prefix))

    def _conv_insert(self, row: dict[str, Any]) -> str:
        return self._table(CONVERSATIONS_TABLE).create_entity(row)["etag"]

    def _conv_get(self, user_id: str | None, conv_id: str) -> tuple[dict[str, Any], str] | None:
        from azure.core.exceptions import ResourceNotFoundError
        table = self._table(CONVERSATIONS_TABLE)
        if user_id:
            try:
                entity = table.get_entity(user_id, conv_id)
            except ResourceNotFoundError:
                return None
            return self._clean(entity), self._etag(entity)
        for entity in table.query_entities("RowKey eq @conv", parameters={"conv": conv_id}):
            return self._clean(entity), self._etag(entity)
        return None

    def _conv_replace(self, row: dict[str, Any], etag: str) -> str:
        from azure.core import MatchConditions
        from azure.core.exceptions import HttpResponseError, ResourceModifiedError
        try:
            return self._table(CONVERSATIONS_TABLE).update_entity(
                self._entity(row), mode="replace", etag=etag, match_condition=MatchConditions.IfNotModified)["etag"]
        except ResourceModifiedError as exc:
            raise Conflict("stale ETag") from exc
        except HttpResponseError as exc:
            if exc.status_code == 412:
                raise Conflict("stale ETag") from exc
            raise

    def _conv_delete(self, row: dict[str, Any]) -> None:
        self._table(CONVERSATIONS_TABLE).delete_entity(row["PartitionKey"], row["RowKey"])

    def _conv_list(self, user_id: str) -> list[tuple[dict[str, Any], str]]:
        return [(self._clean(e), self._etag(e)) for e in
                self._table(CONVERSATIONS_TABLE).query_entities("PartitionKey eq @user", parameters={"user": user_id})]

    def _step_put(self, row: dict[str, Any]) -> None:
        self._table(STEPS_TABLE).upsert_entity(row)

    def _step_rows(self, conv_id: str) -> list[dict[str, Any]]:
        rows = [self._clean(e) for e in
                self._table(STEPS_TABLE).query_entities("PartitionKey eq @conv", parameters={"conv": conv_id})]
        return sorted(rows, key=lambda r: r["RowKey"])

    def _step_delete_all(self, conv_id: str) -> None:
        table = self._table(STEPS_TABLE)
        for entity in list(table.query_entities("PartitionKey eq @conv", parameters={"conv": conv_id})):
            table.delete_entity(entity["PartitionKey"], entity["RowKey"])

    def describe(self) -> dict[str, Any]:
        return {"kind": self.kind, "where": self._where, "container": CONTAINER,
                "tables": [CONVERSATIONS_TABLE, STEPS_TABLE]}


class SqlStore:
    """The design for later (see the module note): Conversations and Steps tables in SQL Server or Azure SQL, the ETag
    a rowversion, content in a JSON column or in Blob. Not implemented: each method says what it would do."""
    kind = "sql"

    def create(self, user_id: str = USER, conv_id: str | None = None) -> Conversation:
        raise NotImplementedError("INSERT INTO Conversations; return the new RowVersion as the ETag.")

    def load(self, conv_id: str, user_id: str | None = None) -> Conversation:
        raise NotImplementedError("SELECT from Conversations and Steps ORDER BY Turn, Step.")

    def append_step(self, conv_id: str, step: Step, expected_etag: str, user_id: str | None = None) -> str:
        raise NotImplementedError("One transaction: UPDATE Conversations WHERE RowVersion = @etag (0 rows is a "
                                  "Conflict), then INSERT INTO Steps.")

    def update_meta(self, conv_id: str, expected_etag: str, *, status: str | None = None, title: str | None = None,
                    overrides: dict[str, Any] | None = None, user_id: str | None = None) -> str:
        raise NotImplementedError("UPDATE Conversations WHERE RowVersion = @etag.")

    def list(self, user_id: str = USER) -> list[Conversation]:
        raise NotImplementedError("SELECT from Conversations WHERE UserId = @user ORDER BY UpdatedAt DESC.")

    def delete(self, conv_id: str, user_id: str | None = None) -> None:
        raise NotImplementedError("DELETE Steps then Conversations in one transaction.")

    def describe(self) -> dict[str, Any]:
        return {"kind": self.kind, "where": "not implemented"}


# ----- choosing a store from the settings -----

AZURITE_ACCOUNT = "devstoreaccount1"


def azurite_connection_string(value: str) -> str:
    """The connection string if it is Azurite's development one, else ValueError. Real accounts sign in without keys."""
    text = value.strip()
    pairs = dict(part.split("=", 1) for part in text.split(";") if "=" in part)
    if text.lower() == "usedevelopmentstorage=true" or pairs.get("AccountName") == AZURITE_ACCOUNT:
        return text
    raise ValueError("Only Azurite's development connection string (devstoreaccount1) is accepted. For an Azure "
                     "Storage account set MODEL_FAILOVER_STORAGE_ACCOUNT and sign in with az login.")


def blob_table_store(account: str = "", blob_endpoint: str = "", table_endpoint: str = "",
                     connection_string: str = "", credential: Any = None) -> BlobTableStore:
    """Azure Storage (keyless, DefaultAzureCredential) or Azurite (its development connection string)."""
    from azure.data.tables import TableServiceClient
    from azure.storage.blob import BlobServiceClient
    if account or blob_endpoint or table_endpoint:
        from azure.identity import DefaultAzureCredential
        credential = credential or DefaultAzureCredential()
        blob_url = blob_endpoint or f"https://{account}.blob.core.windows.net"
        table_url = table_endpoint or f"https://{account}.table.core.windows.net"
        return BlobTableStore(BlobServiceClient(blob_url, credential=credential),
                              TableServiceClient(endpoint=table_url, credential=credential), "azure", blob_url)
    text = azurite_connection_string(connection_string)
    return BlobTableStore(BlobServiceClient.from_connection_string(text), TableServiceClient.from_connection_string(text),
                          "azurite", "Azurite on this machine (127.0.0.1:10000 and 10002)")


def store_from_settings(settings: Any) -> ConversationStore:
    """Azure when an account or endpoints are set, Azurite for its development string, else files in generated/."""
    if (settings.model_failover_storage_account or settings.model_failover_blob_endpoint
            or settings.model_failover_table_endpoint):
        return blob_table_store(settings.model_failover_storage_account, settings.model_failover_blob_endpoint,
                                settings.model_failover_table_endpoint)
    if settings.model_failover_storage_connection_string:
        return blob_table_store(connection_string=settings.model_failover_storage_connection_string)
    return FileStore(settings.generated_dir / "model-failover")
