"""A LangGraph checkpointer that keeps checkpoints in Blob with a Table index: BaseCheckpointSaver's put, put_writes,
get_tuple and list (plus delete_thread).

Layout, in the spirit of the lab's conversation store (shared/lab_store.py):
  Blob   checkpoints/{thread}/{ns}/{checkpoint_id}.json                       the checkpoint, its metadata, its parent
  Blob   checkpoints/{thread}/{ns}/{checkpoint_id}/writes/{task}-{idx}.json   a node's pending writes (a crash resumes from them)
  Table  ModelFailoverCheckpoints  PartitionKey=thread, RowKey={ns}|{checkpoint_id}   blobPath, parentId, step, source

Checkpoint ids sort in time order, so the newest is the largest RowKey. Blobs are written once and never changed, so the
older checkpoints stay as an audit trail and a graph can be replayed from any of them. With nothing configured the same
layout is written to a folder; with Azurite's development connection string or an Azure Storage account (keyless,
DefaultAzureCredential) it goes to Blob and Table Storage. Serialisation is LangGraph's own (self.serde).
"""
from __future__ import annotations

import base64
import json
import threading
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (BaseCheckpointSaver, ChannelVersions, Checkpoint, CheckpointMetadata, CheckpointTuple,
                                       WRITES_IDX_MAP, get_checkpoint_id, get_checkpoint_metadata)

TABLE = "ModelFailoverCheckpoints"
CONTAINER = "model-failover"


class DirBackend:
    """Blobs as files and table rows as JSON files under a folder: no Azure needed."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self._lock = threading.Lock()

    def put_blob(self, path: str, data: str) -> None:
        target = self.root / "blobs" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(data, encoding="utf-8")

    def get_blob(self, path: str) -> str | None:
        target = self.root / "blobs" / path
        return target.read_text(encoding="utf-8") if target.is_file() else None

    def list_blobs(self, prefix: str) -> list[str]:
        base = self.root / "blobs"
        return sorted(p.relative_to(base).as_posix() for p in base.rglob("*.json") if p.relative_to(base).as_posix().startswith(prefix))

    def put_row(self, pk: str, rk: str, row: dict[str, Any]) -> None:
        target = self.root / "tables" / pk / (rk.replace("|", "__") + ".json")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({"PartitionKey": pk, "RowKey": rk, **row}), encoding="utf-8")

    def rows(self, pk: str) -> list[dict[str, Any]]:
        base = self.root / "tables" / pk
        rows = [json.loads(p.read_text(encoding="utf-8")) for p in base.glob("*.json")] if base.is_dir() else []
        return sorted(rows, key=lambda r: r["RowKey"])

    def delete_thread(self, pk: str) -> None:
        import shutil
        for sub in (self.root / "tables" / pk, self.root / "blobs" / "checkpoints" / pk):
            if sub.is_dir():
                shutil.rmtree(sub)


class AzureBackend:
    """Azure Blob Storage and Table Storage (or Azurite), through the lab's own client set-up (shared/lab_store.py)."""

    def __init__(self, store: Any):
        self._blob_service, self._table_service = store._blob_service, store._table_service
        store._setup()  # the container and the lab's tables
        self._container = self._blob_service.get_container_client(CONTAINER)
        self._table_service.create_table_if_not_exists(TABLE)
        self._table = self._table_service.get_table_client(TABLE)

    def put_blob(self, path: str, data: str) -> None:
        self._container.upload_blob(path, data.encode("utf-8"), overwrite=True)

    def get_blob(self, path: str) -> str | None:
        from azure.core.exceptions import ResourceNotFoundError
        try:
            return self._container.download_blob(path).readall().decode("utf-8")
        except ResourceNotFoundError:
            return None

    def list_blobs(self, prefix: str) -> list[str]:
        return sorted(b.name for b in self._container.list_blobs(name_starts_with=prefix))

    def put_row(self, pk: str, rk: str, row: dict[str, Any]) -> None:
        self._table.upsert_entity({"PartitionKey": pk, "RowKey": rk, **row})

    def rows(self, pk: str) -> list[dict[str, Any]]:
        found = [{k: v for k, v in dict(e).items()} for e in self._table.query_entities("PartitionKey eq @pk", parameters={"pk": pk})]
        return sorted(found, key=lambda r: r["RowKey"])

    def delete_thread(self, pk: str) -> None:
        for e in list(self._table.query_entities("PartitionKey eq @pk", parameters={"pk": pk})):
            self._table.delete_entity(e["PartitionKey"], e["RowKey"])
        for name in self.list_blobs(f"checkpoints/{pk}/"):
            self._container.delete_blob(name)


def _enc(serde: Any, value: Any) -> dict[str, str]:
    kind, data = serde.dumps_typed(value)
    return {"t": kind, "b": base64.b64encode(data).decode()}


def _dec(serde: Any, doc: dict[str, str]) -> Any:
    return serde.loads_typed((doc["t"], base64.b64decode(doc["b"])))


class BlobTableSaver(BaseCheckpointSaver[str]):
    def __init__(self, backend: Any):
        super().__init__()
        self.backend = backend

    @staticmethod
    def _path(thread: str, ns: str, checkpoint_id: str) -> str:
        return f"checkpoints/{thread}/{ns or '_'}/{checkpoint_id}.json"

    def put(self, config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata,
            new_versions: ChannelVersions) -> RunnableConfig:
        thread, ns = config["configurable"]["thread_id"], config["configurable"].get("checkpoint_ns", "")
        parent = config["configurable"].get("checkpoint_id")
        meta = get_checkpoint_metadata(config, metadata)
        path = self._path(thread, ns, checkpoint["id"])
        self.backend.put_blob(path, json.dumps({"checkpoint": _enc(self.serde, checkpoint), "metadata": _enc(self.serde, meta),
                                                "parent": parent}))
        self.backend.put_row(thread, f"{ns}|{checkpoint['id']}", {"blobPath": path, "parentId": parent or "",
                                                                  "step": int(meta.get("step", -1)), "source": str(meta.get("source", ""))})
        return {"configurable": {"thread_id": thread, "checkpoint_ns": ns, "checkpoint_id": checkpoint["id"]}}

    def put_writes(self, config: RunnableConfig, writes: Sequence[tuple[str, Any]], task_id: str, task_path: str = "") -> None:
        thread, ns = config["configurable"]["thread_id"], config["configurable"].get("checkpoint_ns", "")
        checkpoint_id = config["configurable"]["checkpoint_id"]
        for idx, (channel, value) in enumerate(writes):
            slot = WRITES_IDX_MAP.get(channel, idx)
            path = f"checkpoints/{thread}/{ns or '_'}/{checkpoint_id}/writes/{task_id}-{slot}.json"
            if slot >= 0 and self.backend.get_blob(path) is not None:
                continue  # an ordinary write is kept once; errors and interrupts (negative slots) are replaced
            self.backend.put_blob(path, json.dumps({"task_id": task_id, "channel": channel, "value": _enc(self.serde, value),
                                                    "task_path": task_path, "slot": slot}))

    def _tuple(self, thread: str, ns: str, checkpoint_id: str) -> CheckpointTuple | None:
        raw = self.backend.get_blob(self._path(thread, ns, checkpoint_id))
        if raw is None:
            return None
        doc = json.loads(raw)
        prefix = f"checkpoints/{thread}/{ns or '_'}/{checkpoint_id}/writes/"
        stored = [json.loads(self.backend.get_blob(p) or "{}") for p in self.backend.list_blobs(prefix)]
        stored = sorted((w for w in stored if w), key=lambda w: (w["task_id"], w["slot"]))
        parent = doc.get("parent")
        return CheckpointTuple(
            {"configurable": {"thread_id": thread, "checkpoint_ns": ns, "checkpoint_id": checkpoint_id}},
            _dec(self.serde, doc["checkpoint"]), _dec(self.serde, doc["metadata"]),
            {"configurable": {"thread_id": thread, "checkpoint_ns": ns, "checkpoint_id": parent}} if parent else None,
            [(w["task_id"], w["channel"], _dec(self.serde, w["value"])) for w in stored])

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        thread, ns = config["configurable"]["thread_id"], config["configurable"].get("checkpoint_ns", "")
        checkpoint_id = get_checkpoint_id(config)
        if not checkpoint_id:
            ids = [r["RowKey"].split("|", 1)[1] for r in self.backend.rows(thread) if r["RowKey"].split("|", 1)[0] == ns]
            if not ids:
                return None
            checkpoint_id = max(ids)
        return self._tuple(thread, ns, checkpoint_id)

    def list(self, config: RunnableConfig | None, *, filter: dict[str, Any] | None = None, before: RunnableConfig | None = None,
             limit: int | None = None) -> Iterator[CheckpointTuple]:
        threads = [config["configurable"]["thread_id"]] if config else sorted({p.split("/")[1] for p in self.backend.list_blobs("checkpoints/")})
        ns_wanted = config["configurable"].get("checkpoint_ns") if config else None
        only = get_checkpoint_id(config) if config else None
        before_id = get_checkpoint_id(before) if before else None
        count = 0
        for thread in threads:
            for row in sorted(self.backend.rows(thread), key=lambda r: r["RowKey"].split("|", 1)[1], reverse=True):
                ns, checkpoint_id = row["RowKey"].split("|", 1)
                if (ns_wanted is not None and ns != ns_wanted) or (only and checkpoint_id != only):
                    continue
                if before_id and checkpoint_id >= before_id:
                    continue
                item = self._tuple(thread, ns, checkpoint_id)
                if item is None or (filter and not all(item.metadata.get(k) == v for k, v in filter.items())):
                    continue
                if limit is not None and count >= limit:
                    return
                count += 1
                yield item

    def delete_thread(self, thread_id: str) -> None:
        self.backend.delete_thread(thread_id)
