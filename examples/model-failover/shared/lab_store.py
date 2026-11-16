"""The lab's own history store, loaded from backend/app/services/conversation_store.py so the examples write exactly the
layout the /model-failover page does:

  Blob   conversations/{user}/{conv}/steps/{turn:06d}-{step:02d}.json
  Table  ModelFailoverConversations (PartitionKey=user, RowKey=conv)  and  ModelFailoverSteps (PartitionKey=conv, RowKey=turn-step)

That file imports only the standard library (and the Azure SDKs when Azure or Azurite is used), so it loads here without
the backend. Sign-in is keyless (DefaultAzureCredential); the only connection string accepted is Azurite's development one.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
_PATH = ROOT / "backend" / "app" / "services" / "conversation_store.py"


def _load() -> Any:
    name = "lab_conversation_store"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, _PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses look their module up while the class is made
    spec.loader.exec_module(module)
    return module


lab = _load()
Step, Conflict, MemoryStore, FileStore = lab.Step, lab.Conflict, lab.MemoryStore, lab.FileStore


def conv_id_for(session_id: str) -> str:
    """A framework's own session or thread id as the lab's 12-hex conversation id (the same id gives the same one)."""
    return hashlib.sha1(session_id.encode()).hexdigest()[:12]


def make_store(folder: Path | None = None) -> Any:
    """Azure (MODEL_FAILOVER_STORAGE_ACCOUNT), Azurite (MODEL_FAILOVER_STORAGE_CONNECTION_STRING) or files."""
    account = os.environ.get("MODEL_FAILOVER_STORAGE_ACCOUNT", "")
    connection = os.environ.get("MODEL_FAILOVER_STORAGE_CONNECTION_STRING", "")
    if account or connection:
        return lab.blob_table_store(account=account, connection_string=connection)
    return lab.FileStore(folder or ROOT / "generated" / "model-failover-examples")


def ensure(store: Any, conv_id: str, user: str = "lab") -> Any:
    """The conversation with this id, made if it is new."""
    try:
        return store.load(conv_id, user)
    except lab.NotFound:
        store.create(user, conv_id)
        return store.load(conv_id, user)
