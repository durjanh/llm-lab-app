"""tools/vector_samples.py, which loads the /vector-db and /graphrag sample documents without the web server, on the
vector page's fake store and embedder: every set loads, a second run replaces rather than duplicates, and it says what
to run when the database or the embedding model is missing."""
from __future__ import annotations

import importlib.util
from pathlib import Path

from backend.app.services import graphrag_sample
from backend.app.services.vectordb import VectorDbService, samples
from backend.tests.test_vectordb import FakeEmbedder, FakeStore

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("vector_samples_tool", ROOT / "tools" / "vector_samples.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def svc(store: FakeStore | None = None) -> VectorDbService:
    return VectorDbService(store or FakeStore(), FakeEmbedder(), None, None)  # type: ignore[arg-type]


def sources(s: VectorDbService) -> set[tuple[str, str]]:
    return {(r["collection"], r["source"]) for r in s.store.rows}


def test_load_puts_every_set_in_and_running_it_again_changes_nothing(capsys):
    s = svc()
    assert tool.main(["load"], s) == 0
    expected = {(v["collection"], name) for v in samples().values() for name in v["documents"]}
    expected |= {(graphrag_sample.COLLECTION, name) for name in graphrag_sample.DOCUMENTS}
    assert sources(s) == expected
    rows = len(s.store.rows)
    assert tool.main(["load"], s) == 0
    assert len(s.store.rows) == rows  # replaced, not added twice
    assert "press Build" in capsys.readouterr().out
    restricted = [r for r in s.store.rows if r["source"] == "Salary bands 2026"]
    assert restricted and all(r["access"] != "everyone" for r in restricted)  # access groups come with the set


def test_load_names_sets_and_refuses_unknown_ones(capsys):
    s = svc()
    assert tool.main(["load", "handbook"], s) == 0
    assert {c for c, _ in sources(s)} == {"handbook"}
    try:
        tool.main(["load", "nope"], s)
    except SystemExit as exc:
        assert exc.code == 2
    assert "no sample set nope" in capsys.readouterr().err


def test_list_shows_sets_and_what_is_loaded(capsys):
    s = svc()
    tool.main(["load", "graphrag"], s)
    capsys.readouterr()
    assert tool.main(["list"], s) == 0
    out = capsys.readouterr().out
    assert "handbook" in out and f"{graphrag_sample.COLLECTION}/" in out


def test_a_missing_database_or_model_says_what_to_run(capsys):
    assert tool.main(["load"], svc(FakeStore(down=True))) == 1
    assert "vector-db.sh" in capsys.readouterr().err
    s = svc()
    s.embedder.model = ""
    assert tool.main(["load"], s) == 1
    assert "local-model.sh --embed" in capsys.readouterr().err
