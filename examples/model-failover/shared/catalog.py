"""The model names for the examples: read from the lab's config/model-failover.json, so no name is written in the code.

The /model-failover page reads the same file (or Table Storage) through its ModelCatalogRepository. Here only the file is
read, with the standard library. A model of "$GPT_DEPLOYMENTS" stands for the deployments in AZURE_OPENAI_DEPLOYMENTS.
Set MODEL_FAILOVER_CATALOG_PATH to read another file. The environment is the only other input; no .env is opened.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
PLACEHOLDER = "$GPT_DEPLOYMENTS"


def path() -> Path:
    given = Path(os.environ.get("MODEL_FAILOVER_CATALOG_PATH") or "config/model-failover.json")
    return given if given.is_absolute() else ROOT / given


def load() -> dict[str, Any]:
    return json.loads(path().read_text(encoding="utf-8"))


def gpt_deployments() -> list[str]:
    return [d.strip() for d in os.environ.get("AZURE_OPENAI_DEPLOYMENTS", "").split(",")
            if d.strip().startswith("gpt-") and "image" not in d]


def models(provider: str | None = None) -> list[dict[str, Any]]:
    """The enabled models in fallback order, the placeholder expanded; each has name, model, provider and context_window."""
    out: list[dict[str, Any]] = []
    for e in load()["models"]:
        if not e.get("enabled", True) or (provider and e.get("provider") != provider):
            continue
        if e["model"] == PLACEHOLDER:
            if os.environ.get("AZURE_OPENAI_ENDPOINT"):
                out += [{**e, "model": d, "name": d} for d in gpt_deployments()]
        else:
            out.append({**e, "name": e.get("name") or e["model"]})
    return out


def first(provider: str) -> dict[str, Any] | None:
    found = models(provider)
    return found[0] if found else None


def compact_model() -> str:
    """The model that writes summaries: the catalog's compact_model, as a model id."""
    wanted = load()["compact_model"]
    for e in load()["models"]:
        if wanted in (e.get("name"), e["model"]):
            return e["model"]
    return wanted
