"""tools/shop_data.py, the command-line script that sets up and fills the shop without the web server, on the memory
store and a fake embedder; and the import lock that keeps it and the backend from writing into one shop at once."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest

from backend.app.services import shop_data as D
from backend.app.services.shop_store import MemoryShopStore
from backend.app.settings import Settings
from backend.tests.test_shop import DIMS, LAB, LAB_TAB, FakeEmbedder, make

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("shop_data_tool", ROOT / "tools" / "shop_data.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def settings(tmp_path: Path) -> Settings:
    return Settings(port=8000, budget_usd=5.0, frontend_dist=tmp_path, models_dir=tmp_path / "none",
                    sites_dir=tmp_path / "sites", casework_dir=tmp_path / "casework",
                    generated_dir=tmp_path / "generated")


def shop(tmp_path: Path, store: MemoryShopStore | None = None) -> Any:
    s = tool.Shop(settings(tmp_path), store=store or MemoryShopStore(dims=DIMS), embedder=FakeEmbedder())
    s.worker.backoff_s = 0.0
    s.importer.product_batch = 100
    return s


@pytest.fixture(autouse=True)
def no_backend(monkeypatch):
    monkeypatch.setattr(tool, "backend_running", lambda port: False)
    monkeypatch.setattr(D, "SIZES", (300,))


def test_setup_status_and_generate_fill_the_shop_and_run_again_safely(tmp_path, capsys):
    s = shop(tmp_path)
    assert tool.main(["setup"], s) == 0
    assert "0 products" in capsys.readouterr().out
    assert tool.main(["generate", "300"], s) == 0
    out = capsys.readouterr().out
    assert "Ready: 300 products" in out
    c = s.store.counts()
    assert c["products"] == 300 and c["embedded"] == 300 and s.store.indexed
    assert tool.main(["embed"], s) == 0 and "Embedding 0 pending" in capsys.readouterr().out
    assert tool.main(["status"], s) == 0
    assert "300 products" in capsys.readouterr().out
    state = json.loads((tmp_path / "generated" / "shop" / "import.json").read_text())
    assert state["state"] == "done"  # the file the backend reads, so the page shows the same result


def test_the_script_writes_the_state_file_the_backend_reads(tmp_path):
    _, service, _ = make(tmp_path, products=0)
    assert tool.state_path(settings(tmp_path)) == service.importer.path


def test_generate_refuses_while_the_backend_runs_unless_forced(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(tool, "backend_running", lambda port: True)
    s = shop(tmp_path)
    assert tool.main(["generate", "300"], s) == 1
    assert "backend is running" in capsys.readouterr().out and s.store.counts()["products"] == 0
    assert tool.main(["generate", "300", "--force"], s) == 0 and s.store.counts()["products"] == 300


def test_an_imported_file_is_embedded_and_a_bad_one_is_refused(tmp_path, capsys):
    s = shop(tmp_path)
    good = tmp_path / "p.jsonl"
    good.write_text(json.dumps({**D.generate_product(5), "id": "imp-1"}) + "\n")
    assert tool.main(["import", "products", str(good)], s) == 0
    assert s.store.counts()["products"] == 1 and "imp-1" in s.store.vectors
    bad = tmp_path / "bad.jsonl"
    bad.write_text("{oops\n")
    assert tool.main(["import", "products", str(bad)], s) == 1
    assert "Nothing was imported" in capsys.readouterr().err and s.store.counts()["products"] == 1
    assert tool.main(["import", "products", str(tmp_path / "missing.jsonl")], s) == 1


def test_embed_retry_puts_failed_products_back(tmp_path, capsys):
    s = shop(tmp_path)
    s.store.upsert_products([D.generate_product(i) for i in range(3)])
    s.worker.embedder.fail = lambda texts: True
    s.worker.max_attempts = 1
    assert tool.main(["embed"], s) == 1
    assert "3 failed" in capsys.readouterr().out
    s.worker.embedder.fail = None
    assert tool.main(["embed", "--retry"], s) == 0
    assert len(s.store.vectors) == 3


def test_embed_without_a_model_says_what_to_run(tmp_path, capsys):
    s = shop(tmp_path)
    s.embedder.model = ""
    assert tool.main(["embed"], s) == 1
    assert "local-model.sh --embed" in capsys.readouterr().out


def test_another_process_holding_the_import_lock_refuses_generate_and_import(tmp_path):
    """The backend's Lab tab and the script share one lock in the database: while one holds it, the other is told."""
    client, service, _ = make(tmp_path, products=0)
    release = service.store.try_job_lock()  # the other process
    assert release is not None and service.store.try_job_lock() is None
    r = client.post("/api/shop/generate", headers=LAB_TAB, json={"size": D.SIZES[0]})
    assert r.status_code == 409 and "shop-data.sh" in r.json()["error"]["message"]
    r = client.post("/api/shop/import", headers=LAB_TAB, data={"kind": "products"},
                    files={"file": ("p.jsonl", json.dumps(D.generate_product(1)).encode(), "application/json")})
    assert r.status_code == 409 and service.store.counts()["products"] == 0
    release()
    r = client.post("/api/shop/import", headers=LAB_TAB, data={"kind": "products"},
                    files={"file": ("p.jsonl", json.dumps(D.generate_product(1)).encode(), "application/json")})
    assert r.status_code == 200
    again = service.store.try_job_lock()
    assert again is not None  # the import let it go
    again()


def test_the_lock_is_let_go_after_a_rejected_file_a_finished_run_and_a_failed_start(tmp_path, monkeypatch):
    client, service, _ = make(tmp_path, products=0)
    monkeypatch.setattr(D, "SIZES", (300,))
    service.importer.product_batch = 100
    r = client.post("/api/shop/import", headers=LAB_TAB, data={"kind": "products"},
                    files={"file": ("p.jsonl", b"{oops\n", "application/json")})
    assert r.status_code == 400
    assert client.post("/api/shop/generate", headers=LAB_TAB, json={"size": 300}).status_code == 200
    service.importer.wait(10)
    assert client.get("/api/shop/import", headers=LAB).json()["state"] == "done"
    store = service.store

    def broken(dims: int) -> None:
        raise RuntimeError("reset failed")
    monkeypatch.setattr(store, "reset", broken)
    with pytest.raises(RuntimeError):
        service.importer.generate(300)  # a new run (the last one finished), so it resets first
    release = store.try_job_lock()
    assert release is not None
    release()


def test_a_reset_keeps_the_memory_stores_lock(tmp_path):
    store = MemoryShopStore(dims=DIMS)
    release = store.try_job_lock()
    store.reset(DIMS)  # reset builds the store again; another holder must still be shut out
    assert store.try_job_lock() is None
    release()


def test_refresh_rewrites_generated_products_and_keeps_shoppers_orders_stock_and_deletions(tmp_path, monkeypatch,
                                                                                         capsys):
    s = shop(tmp_path)
    assert tool.main(["refresh"], s) == 1  # nothing generated yet
    assert "Generate one first" in capsys.readouterr().err
    assert tool.main(["generate", "300"], s) == 0
    before = s.store.counts()
    s.store.products_["p0000001"]["stock"] = 1  # shoppers have bought all but one
    stock = 1
    s.store.delete_product("p0000002")
    version = s.store.get_meta("data_version")
    original = D.generate_product

    def reworded(i: int, seed: str = D.SEED) -> dict:
        row = original(i, seed)
        if i % 10 == 0:
            row["description"] += " Now with a lifetime guarantee."  # a change to the generator's wording
        return row
    monkeypatch.setattr(D, "generate_product", reworded)
    calls = len(s.embedder.calls)
    assert tool.main(["refresh"], s) == 0
    assert "lifetime guarantee" in s.store.products_["p0000010"]["description"]
    assert s.store.products_["p0000001"]["stock"] == stock and "p0000002" not in s.store.products_
    after = s.store.counts()
    assert (after["customers"], after["orders"]) == (before["customers"], before["orders"])
    embedded = sum(len(c) for c in s.embedder.calls[calls:])
    assert embedded == 30  # only the reworded tenth is embedded again
    assert s.store.get_meta("data_version") != version  # cached answers quoting the old wording are not reused
