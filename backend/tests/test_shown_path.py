"""Pages show a file's place in the repo (config/model-failover.json), never this machine's full path or home folder."""
from __future__ import annotations

from pathlib import Path

from backend.app.services.conversation_store import FileStore
from backend.app.services.model_catalog import JsonFileCatalog
from backend.app.shared import ROOT, shown_path


def test_a_path_in_the_repo_is_shown_from_the_repo() -> None:
    assert shown_path(ROOT / "config" / "model-failover.json") == "config/model-failover.json"
    assert shown_path(str(ROOT / "generated" / "model-failover")) == "generated/model-failover"


def test_a_path_outside_the_repo_shows_only_its_folder_and_name(tmp_path: Path) -> None:
    got = shown_path(tmp_path / "catalog.json")
    assert got == f"…/{tmp_path.name}/catalog.json" and str(Path.home()) not in got


def test_the_model_failover_page_is_told_where_its_files_are_from_the_repo() -> None:
    assert JsonFileCatalog(ROOT / "config" / "model-failover.json").describe()["where"] == "config/model-failover.json"
    assert FileStore(ROOT / "generated" / "model-failover").describe()["where"] == "generated/model-failover"
