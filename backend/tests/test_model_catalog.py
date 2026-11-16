"""The model catalog of /model-failover: the JSON file and Table Storage behind one repository, live switching, the rules
a catalog must keep, and the routes. A fake client answers; no network, no key, no cost. TableCatalog also runs against
Azurite when it is up (skipped otherwise)."""
from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.gateways.claude import ClaudeGateway
from backend.app.main import create_app
from backend.app.services import model_catalog as mc
from backend.app.services.conversation_store import Conflict, MemoryStore
from backend.app.services.model_catalog import (CatalogEnv, CatalogError, CatalogInvalid, JsonFileCatalog, MemoryCatalog,
                                                ModelCatalog, TableCatalog, build, resolve)
from backend.app.services.model_failover import Compaction, ModelFailoverService, TicketDesk
from backend.app.services.model_router import ModelRouter
from backend.app.services.runs import RunRegistry, RunStreamer
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_api import LAB
from backend.tests.test_model_failover import (GPT, HAIKU, SONNET, Fake, azurite_up, events, new_conv, talk, text)

REAL = Path(__file__).resolve().parents[2] / "config" / "model-failover.json"


def doc(*models: dict[str, Any], compact: str = HAIKU) -> dict[str, Any]:
    return {"compact_model": compact, "models": list(models)}


def entry(model: str, window: int = 200_000, **extra: Any) -> dict[str, Any]:
    return {"model": model, "provider": "anthropic", "context_window": window, **extra}


def gpt_entry(model: str, window: int = 128_000, **extra: Any) -> dict[str, Any]:
    return {"model": model, "provider": "azure-openai", "context_window": window, **extra}


BASE = doc(entry(SONNET, note="primary"), entry(HAIKU, note="same family, cheaper"))


def edit(path: Path, document: Any) -> None:
    """Writes the file the way an editor does: a new file renamed over the old one."""
    tmp = path.with_name(path.name + ".new")
    tmp.write_text(document if isinstance(document, str) else json.dumps(document), encoding="utf-8")
    os.replace(tmp, path)


def make_service(tmp_path: Path, script: dict[str, list[Any]] | None = None, document: Any = None,
                 env: CatalogEnv | None = None, cfg: Compaction | None = None):
    path = tmp_path / "model-failover.json"
    edit(path, document or BASE)
    repo = JsonFileCatalog(path, env or CatalogEnv(), check_every_s=0)
    models = ModelCatalog(repo, env or CatalogEnv())
    fake = Fake(script or {})
    svc = ModelFailoverService(ClaudeGateway(fake), SpendTracker(5.0), RunStreamer(RunRegistry(), 1.0), MemoryStore(),
                               ModelRouter(cooldown_s=30, sleep=lambda s: None, source=models.source), cfg or Compaction(),
                               TicketDesk(), models=models)
    return svc, fake, path, repo


def names(svc: ModelFailoverService) -> list[str]:
    return [p["name"] for p in svc.router_status()["pools"]]


# ----- the shipped file -----

def test_the_shipped_file_is_valid_and_names_no_deployment() -> None:
    raw = json.loads(REAL.read_text(encoding="utf-8"))
    catalog = build(raw, CatalogEnv())
    assert [e.pool_name for e in catalog.entries][:2] == [SONNET, HAIKU]
    assert any(e.model == mc.GPT_PLACEHOLDER for e in catalog.entries)
    assert "gpt-5" not in REAL.read_text(encoding="utf-8")


# ----- live switching -----

def test_editing_the_file_changes_the_pools_on_the_next_turn(tmp_path: Path) -> None:
    svc, fake, path, _ = make_service(tmp_path, {HAIKU: [[text("one")], [text("two")]], SONNET: [[text("s")]]})
    conv = new_conv(svc)
    assert names(svc) == [SONNET, HAIKU]
    talk(svc, conv, "first", primary=None)
    assert fake.models_called() == [SONNET]
    edit(path, doc(entry(HAIKU, note="now primary"), entry(SONNET, enabled=False)))  # no restart, no new service
    assert names(svc) == [HAIKU]
    talk(svc, conv, "second", primary=None)
    assert fake.models_called() == [SONNET, HAIKU]


def test_an_invalid_edit_keeps_the_last_good_catalog_and_reports_the_error(tmp_path: Path) -> None:
    svc, _, path, repo = make_service(tmp_path)
    good = svc.catalog()["version"]
    for bad in ("{ not json", json.dumps(doc(entry(SONNET, enabled=False))), json.dumps(doc(entry("mystery-model"))),
                json.dumps(doc(entry(SONNET, 100)))):
        edit(path, bad)
        shown = svc.catalog()
        assert names(svc) == [SONNET, HAIKU] and shown["version"] == good and shown["error"]
    edit(path, doc(entry(HAIKU)))
    shown = svc.catalog()
    assert names(svc) == [HAIKU] and shown["error"] == "" and shown["version"] != good


def test_a_missing_file_with_no_earlier_catalog_is_a_clear_error(tmp_path: Path) -> None:
    repo = JsonFileCatalog(tmp_path / "nope.json", check_every_s=0)
    with pytest.raises(CatalogError):
        repo.get()
    with pytest.raises(ApiError) as caught:
        ModelRouter(source=ModelCatalog(repo).source).order()
    assert caught.value.status == 503


def test_breaker_state_and_faults_survive_a_catalog_change_for_unchanged_pools(tmp_path: Path) -> None:
    svc, _, path, _ = make_service(tmp_path)
    svc.router.inject(SONNET, "529", 1)
    svc.router.call(lambda p: p.name)  # sonnet takes the fault: its breaker opens, haiku answers
    svc.inject(HAIKU, "529", 2)
    before = {p["name"]: p for p in svc.router_status()["pools"]}
    assert before[SONNET]["state"] == "open" and before[HAIKU]["faults"] == ["529", "529"]
    edit(path, doc(entry(HAIKU, 150_000), entry(SONNET, note="moved"), entry("claude-opus-5-5")))
    after = {p["name"]: p for p in svc.router_status()["pools"]}
    assert list(after) == [HAIKU, SONNET, "claude-opus-5-5"]
    assert after[HAIKU]["faults"] == ["529", "529"] and after[HAIKU]["context_tokens"] == 150_000
    assert after[SONNET]["state"] == "open" and after[SONNET]["failures"] == 1
    assert after["claude-opus-5-5"]["state"] == "closed" and after["claude-opus-5-5"]["faults"] == []
    edit(path, doc(entry(HAIKU)))  # a pool that goes and comes back starts clean
    assert names(svc) == [HAIKU]
    edit(path, BASE)
    assert {p["name"]: p for p in svc.router_status()["pools"]}[SONNET]["state"] == "closed"


def test_a_pool_removed_mid_call_is_simply_skipped(tmp_path: Path) -> None:
    svc, fake, path, _ = make_service(tmp_path, {HAIKU: [[text("from haiku")]]})

    def sonnet_fails_and_is_removed() -> Exception:
        edit(path, doc(entry(HAIKU)))  # the catalog changes while sonnet's call is in flight
        return _overloaded()

    fake.script[SONNET] = [sonnet_fails_and_is_removed]
    conv = new_conv(svc)
    out = talk(svc, conv, "hello", primary=None)
    assert out[-1]["type"] == "done" and out[-1]["reply"] == "from haiku"
    assert names(svc) == [HAIKU]
    # The next turn, with the removed pool asked for by name, is refused clearly rather than crashing.
    with pytest.raises(ApiError) as caught:
        svc.send(conv, "again", SONNET)
    assert caught.value.status == 400


def _overloaded() -> Exception:
    from backend.tests.test_model_failover import status_error
    return status_error(529)


# ----- prices -----

def test_a_model_with_its_own_prices_is_charged_by_them(tmp_path: Path) -> None:
    """A GPT deployment PRICES does not list (a new one) is charged at the price given in the catalog."""
    document = doc(gpt_entry("acme-1", input_per_m=2.0, output_per_m=8.0, note="new"), entry(HAIKU), compact="acme-1")
    svc, fake, _, _ = make_service(tmp_path, {"acme-1": [[text("hi")]]}, document, env=CatalogEnv(("acme-1",)))
    talk(svc, new_conv(svc), "hello", primary=None)
    assert fake.models_called() == ["acme-1"]
    assert svc.spend.spent_usd == pytest.approx((1000 * 2.0 + 100 * 8.0) / 1_000_000)


def test_a_model_without_a_price_is_rejected_on_save_and_on_load(tmp_path: Path) -> None:
    svc, _, path, _ = make_service(tmp_path)
    version = svc.catalog()["version"]
    with pytest.raises(ApiError) as caught:
        svc.save_catalog(doc(gpt_entry("acme-1"), entry(HAIKU)), version)
    assert caught.value.status == 400 and "price" in caught.value.message
    with pytest.raises(ApiError):  # one price without the other
        svc.save_catalog(doc(gpt_entry("acme-1", input_per_m=1.0), entry(HAIKU)), version)
    assert names(svc) == [SONNET, HAIKU]


@pytest.mark.parametrize("claude", [
    entry("claude-opus-4-1", input_per_m=0.0, output_per_m=0.0),  # a Claude model the lab does not accept, priced at zero
    entry("claude-opus-4-1"),
    entry(SONNET, input_per_m=0.0, output_per_m=0.0),  # an accepted one, with a price of its own
])
def test_a_claude_entry_must_be_a_lab_model_at_its_list_price(tmp_path: Path, claude: dict[str, Any]) -> None:
    """Review finding: a saved catalog could send paid calls to any Claude id at its own (zero) price, so neither the
    spending cap nor the run cap would ever rise. The catalog follows the same allow-list as every other route."""
    svc, fake, _, _ = make_service(tmp_path)
    with pytest.raises(ApiError) as caught:
        svc.save_catalog(doc(claude, entry(HAIKU)), svc.catalog()["version"])
    message = caught.value.message
    assert caught.value.status == 400 and ("must be one of" in message or "list price" in message)
    assert names(svc) == [SONNET, HAIKU] and fake.models_called() == []


def test_the_models_own_price_does_not_override_the_price_list() -> None:
    from backend.app.shared import PRICES, cost_usd
    usage = type("U", (), {"input_tokens": 1000, "output_tokens": 0})()
    assert cost_usd(usage, SONNET, {"input": 99.0, "output": 99.0, "cache_read": 1.0}) == pytest.approx(1000 * PRICES[SONNET]["input"] / 1e6)


# ----- the GPT placeholder and availability -----

def test_the_gpt_placeholder_expands_to_the_configured_deployments() -> None:
    catalog = build(doc(entry(SONNET), {"model": mc.GPT_PLACEHOLDER, "provider": "azure-openai", "context_window": 128_000,
                                        "note": "other provider"}))
    got = resolve(catalog, CatalogEnv((GPT, "gpt-4.1-mini")))
    assert [(r.entry.pool_name, r.available, r.entry.context_window) for r in got] == [
        (SONNET, True, 200_000), (GPT, True, 128_000), ("gpt-4.1-mini", True, 128_000)]
    assert all(r.entry.provider == "azure-openai" for r in got[1:])


def test_an_unavailable_deployment_is_marked_not_fatal(tmp_path: Path) -> None:
    document = doc(entry(SONNET), {"model": mc.GPT_PLACEHOLDER, "provider": "azure-openai"},
                   {"model": "gpt-4.1-mini", "provider": "azure-openai"})
    svc, _, _, _ = make_service(tmp_path, document=document, env=CatalogEnv())  # no deployments at all
    shown = svc.catalog()
    gone = {r["name"]: r for r in shown["resolved"]}
    assert not gone[mc.GPT_PLACEHOLDER]["available"] and "configured" in gone[mc.GPT_PLACEHOLDER]["reason"]
    assert not gone["gpt-4.1-mini"]["available"] and shown["error"] == ""
    assert names(svc) == [SONNET]
    (tmp_path / "b").mkdir()
    with_gpt, _, _, _ = make_service(tmp_path / "b", document=document, env=CatalogEnv((GPT,)))
    assert names(with_gpt) == [SONNET, GPT]  # gpt-4.1-mini is still not a configured deployment


def test_an_all_unavailable_catalog_keeps_the_last_good_pools(tmp_path: Path) -> None:
    svc, _, path, _ = make_service(tmp_path)
    edit(path, doc({"model": "gpt-4.1-mini", "provider": "azure-openai"}, compact=SONNET))
    assert names(svc) == [SONNET, HAIKU]
    assert "enabled and available" in svc.catalog()["error"]


# ----- compaction model -----

def test_the_compaction_model_comes_from_the_catalog(tmp_path: Path) -> None:
    svc, fake, path, _ = make_service(tmp_path, {SONNET: [[text("a")], [text("b")], [text("Summary by sonnet.")]]},
                                      cfg=Compaction(0.7, 60000, 1, ""))
    assert svc.defaults().model == HAIKU and svc.info()["compaction"]["compact_model"] == HAIKU
    edit(path, doc(entry(SONNET), entry(HAIKU), compact=SONNET))
    assert svc.defaults().model == SONNET
    conv = new_conv(svc)
    talk(svc, conv, "one")
    talk(svc, conv, "two")
    step = svc.compact_now(conv, primary=HAIKU)["step"]
    assert step["model"] == SONNET and fake.models_called()[-1] == SONNET
    svc.compaction = Compaction(0.7, 60000, 1, HAIKU)  # MODEL_FAILOVER_COMPACT_MODEL still overrides
    assert svc.defaults().model == HAIKU


def test_the_compaction_model_may_be_a_model_id_and_must_be_known() -> None:
    assert build(doc(entry(SONNET, name="primary"), compact=SONNET)).compact_model == SONNET
    assert build(doc(entry(SONNET), compact="claude-opus-5-5")).compact_model == "claude-opus-5-5"
    with pytest.raises(CatalogInvalid):
        build(doc(entry(SONNET), compact="who-knows"))


# ----- the rules -----

@pytest.mark.parametrize("bad", [
    doc(), doc(entry(SONNET), entry(SONNET)), doc(entry(SONNET, 3999)), doc(entry(SONNET, enabled=False)),
    doc({"model": SONNET, "provider": "bedrock"}), doc(entry(SONNET, note=5)), doc(entry("acme-1")),
    doc(entry(SONNET, input_per_m=-1, output_per_m=1)), doc(entry(SONNET), compact=""), [], {"models": "x"},
    doc({"model": mc.GPT_PLACEHOLDER, "provider": "anthropic"}), doc({"model": "bad name!", "provider": "anthropic"}),
])
def test_a_catalog_that_breaks_a_rule_is_refused(bad: Any) -> None:
    with pytest.raises(CatalogInvalid) as caught:
        build(bad)
    assert caught.value.problems


# ----- saving -----

def test_a_save_writes_atomically_and_applies_at_once(tmp_path: Path) -> None:
    svc, _, path, _ = make_service(tmp_path)
    shown = svc.catalog()
    saved = svc.save_catalog(doc(entry(HAIKU, note="first"), entry(SONNET), compact=HAIKU), shown["version"])
    assert [e["name"] for e in saved["entries"]] == [HAIKU, SONNET] and saved["version"] != shown["version"]
    assert names(svc) == [HAIKU, SONNET]
    assert json.loads(path.read_text(encoding="utf-8"))["models"][0]["note"] == "first"
    assert not [p for p in tmp_path.iterdir() if p.suffix == ".tmp"]


def test_a_save_with_a_stale_version_is_a_409(tmp_path: Path) -> None:
    svc, _, path, _ = make_service(tmp_path)
    old = svc.catalog()["version"]
    svc.save_catalog(doc(entry(SONNET), entry(HAIKU, note="x")), old)
    with pytest.raises(ApiError) as caught:
        svc.save_catalog(doc(entry(HAIKU)), old)
    assert caught.value.status == 409
    edit(path, doc(entry(SONNET), entry(HAIKU, note="edited by hand")))  # an edit on disk makes a held version stale too
    with pytest.raises(ApiError) as again:
        svc.save_catalog(doc(entry(HAIKU)), svc.catalog()["version"][:-1] + "0")
    assert again.value.status == 409


def test_two_saves_at_once_let_only_one_win(tmp_path: Path) -> None:
    svc, _, _, _ = make_service(tmp_path)
    version = svc.catalog()["version"]
    gate, results = threading.Barrier(2), []

    def save(note: str) -> None:
        gate.wait()
        try:
            svc.save_catalog(doc(entry(SONNET, note=note), entry(HAIKU)), version)
            results.append(200)
        except ApiError as exc:
            results.append(exc.status)

    threads = [threading.Thread(target=save, args=(n,)) for n in ("a", "b")]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == [200, 409]


def test_a_broken_file_can_be_repaired_by_saving_over_the_last_good_version(tmp_path: Path) -> None:
    svc, _, path, _ = make_service(tmp_path)
    good = svc.catalog()["version"]
    edit(path, "{ broken")
    assert svc.catalog()["error"]
    saved = svc.save_catalog(doc(entry(HAIKU)), good)
    assert saved["error"] == "" and names(svc) == [HAIKU]


def test_the_memory_catalog_follows_the_same_rules() -> None:
    repo = MemoryCatalog(BASE)
    v = repo.get().version
    repo.save(build(doc(entry(HAIKU))), v)
    with pytest.raises(Conflict):
        repo.save(build(doc(entry(SONNET))), v)
    with pytest.raises(CatalogInvalid):
        repo.save(build(doc(entry(SONNET, 1))), repo.get().version)


# ----- Table Storage, against Azurite -----

@pytest.fixture
def table() -> Any:
    if not azurite_up():
        pytest.skip("Azurite is not running on 127.0.0.1:10000 and 10002")
    from azure.data.tables import TableServiceClient
    service = TableServiceClient.from_connection_string("UseDevelopmentStorage=true")
    name = "Catalog" + uuid.uuid4().hex[:10]
    yield service, name
    service.delete_table(name)


def test_the_table_catalog_round_trips_conflicts_and_caches(table: Any, tmp_path: Path) -> None:
    service, name = table
    clock = [0.0]
    a = TableCatalog(service, CatalogEnv(), ttl_s=30, table=name, clock=lambda: clock[0])
    b = TableCatalog(service, CatalogEnv(), ttl_s=30, table=name, clock=lambda: clock[0])  # another instance
    with pytest.raises(CatalogError) as empty:
        a.get()
    assert "seed" in str(empty.value)
    seeded = mc.seed_table(a, REAL)
    assert [e.pool_name for e in seeded.entries][:2] == [SONNET, HAIKU] and seeded.compact_model == HAIKU
    with pytest.raises(CatalogError):
        mc.seed_table(a, REAL)  # it will not overwrite without --force
    assert mc.seed_table(a, REAL, force=True).version
    first = b.get()
    assert first.entries == a.get().entries and first.version == a.get().version

    # b caches: a change by a is not seen until the TTL has passed, then it is, without a restart
    saved = a.save(build(doc(entry(HAIKU, note="moved up"), entry(SONNET), gpt_entry("acme-1", input_per_m=0.1, output_per_m=0.5),
                             compact=SONNET)), a.get().version)
    assert [e.pool_name for e in saved.entries] == [HAIKU, SONNET, "acme-1"]
    assert b.get().version == first.version
    clock[0] = 31
    assert [e.pool_name for e in b.get().entries] == [HAIKU, SONNET, "acme-1"] and b.get().compact_model == SONNET
    assert b.get().entries[2].input_per_m == 0.1

    # a stale version loses; two writers holding the same version cannot both win
    stale = first.version
    with pytest.raises(Conflict):
        b.save(build(doc(entry(SONNET))), stale)
    current = a.get().version
    outcomes, gate = [], threading.Barrier(2)

    def go(repo: TableCatalog, note: str) -> None:
        gate.wait()
        try:
            repo.save(build(doc(entry(SONNET, note=note), entry(HAIKU))), current)
            outcomes.append("ok")
        except Conflict:
            outcomes.append("conflict")

    threads = [threading.Thread(target=go, args=(r, n)) for r, n in ((a, "a"), (b, "b"))]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(outcomes) == ["conflict", "ok"]
    # a row removed by a save is gone, and reload ignores the TTL
    a.save(build(doc(entry(HAIKU))), a.reload().version)
    assert [e.pool_name for e in b.reload().entries] == [HAIKU]
    assert a.describe()["table"] == name


def test_the_table_catalog_drives_the_router(table: Any) -> None:
    service, name = table
    repo = TableCatalog(service, CatalogEnv(), ttl_s=0.0, table=name)
    mc.seed_table(repo, REAL)
    models = ModelCatalog(repo, CatalogEnv())
    router = ModelRouter(source=models.source)
    assert [p.name for p in router.pools] == [SONNET, HAIKU]
    repo.save(build(doc(entry(HAIKU))), repo.get().version)
    assert [p.name for p in router.pools] == [HAIKU]


def test_table_storage_only_accepts_azurite_keys() -> None:
    settings = Settings(model_failover_storage_connection_string="DefaultEndpointsProtocol=https;AccountName=prod;"
                                                                  "AccountKey=abc;EndpointSuffix=core.windows.net")
    with pytest.raises(ValueError):
        mc.table_catalog_from_settings(settings, CatalogEnv())
    with pytest.raises(ValueError):
        mc.table_catalog_from_settings(Settings(), CatalogEnv())  # nothing configured


# ----- the routes -----

def lab(tmp_path: Path, script: dict[str, list[Any]] | None = None) -> tuple[TestClient, Path]:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><div id=root></div>")
    path = tmp_path / "config" / "model-failover.json"
    path.parent.mkdir()
    edit(path, BASE)
    settings = Settings(port=8000, budget_usd=2.0, frontend_dist=dist, models_dir=tmp_path / "no-models",
                        generated_dir=tmp_path / "generated", model_failover_catalog_path=str(path))
    api = TestClient(create_app(settings, client=Fake(script or {})), base_url="http://localhost:8000")
    return api, path


def test_the_catalog_routes_need_the_lab_header(tmp_path: Path) -> None:
    api, _ = lab(tmp_path)
    assert api.get("/api/model-failover/catalog").status_code == 403
    assert api.put("/api/model-failover/catalog", json={}).status_code == 403
    assert api.post("/api/model-failover/catalog/reload").status_code == 403


def test_the_catalog_route_shows_models_source_version_and_availability(tmp_path: Path) -> None:
    api, path = lab(tmp_path)
    got = api.get("/api/model-failover/catalog", headers=LAB).json()
    assert [e["name"] for e in got["entries"]] == [SONNET, HAIKU] and got["compact_model"] == HAIKU
    assert got["source"]["kind"] == "file" and got["source"]["where"] == str(path)
    assert got["version"] and got["error"] == "" and all(r["available"] for r in got["resolved"])
    assert SONNET in got["known_models"] and mc.GPT_PLACEHOLDER in got["known_models"]
    info = api.get("/api/model-failover/info", headers=LAB).json()
    assert [p["name"] for p in info["router"]["pools"]] == [SONNET, HAIKU]


def test_the_catalog_route_saves_validates_and_reloads(tmp_path: Path) -> None:
    api, path = lab(tmp_path)
    got = api.get("/api/model-failover/catalog", headers=LAB).json()
    body = {"models": [{"model": HAIKU, "context_window": 150_000, "note": "first"}, {"model": SONNET}],
            "compact_model": SONNET, "version": got["version"]}
    ok = api.put("/api/model-failover/catalog", headers=LAB, json=body)
    assert ok.status_code == 200 and [e["name"] for e in ok.json()["entries"]] == [HAIKU, SONNET]
    assert [p["name"] for p in api.get("/api/model-failover/router", headers=LAB).json()["pools"]] == [HAIKU, SONNET]
    assert api.put("/api/model-failover/catalog", headers=LAB, json=body).status_code == 409  # the old version
    fresh = ok.json()["version"]
    for bad in ({**body, "version": fresh, "models": [{"model": "acme-1"}]},
                {**body, "version": fresh, "models": [{"model": SONNET, "provider": "nope"}]},
                {**body, "version": fresh, "models": [{"model": SONNET, "context_window": 10}]},
                {**body, "version": fresh, "models": []}, {**body, "version": fresh, "compact_model": "unknown-x"},
                {**body, "version": fresh, "models": [{"model": SONNET, "enabled": False}]}):
        r = api.put("/api/model-failover/catalog", headers=LAB, json=bad)
        assert r.status_code == 400 and r.json()["error"]["message"], bad
    nothing = {k: v for k, v in body.items() if k != "version"}
    assert api.put("/api/model-failover/catalog", headers=LAB, json=nothing).status_code == 400
    header = api.put("/api/model-failover/catalog", headers={**LAB, "If-Match": fresh}, json=nothing)  # If-Match works too
    assert header.status_code == 200
    edit(path, "{ nope")
    again = api.post("/api/model-failover/catalog/reload", headers=LAB).json()
    assert again["error"] and [e["name"] for e in again["entries"]] == [HAIKU, SONNET]


def test_no_model_name_is_left_in_the_service() -> None:
    source = (Path(mc.__file__).parent / "model_failover.py").read_text(encoding="utf-8")
    code = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith(("#", '"""')))
    assert "claude-haiku" not in code.split('"""')[-1] and "default_pools" not in source and 'startswith("gpt-")' not in source


def test_an_empty_version_in_the_body_defers_to_the_if_match_header(tmp_path: Path) -> None:
    api, _ = lab(tmp_path)
    got = api.get("/api/model-failover/catalog", headers=LAB).json()
    body = {"models": [{"model": SONNET}, {"model": HAIKU}], "compact_model": HAIKU, "version": ""}
    r = api.put("/api/model-failover/catalog", headers={**LAB, "If-Match": f'"{got["version"]}"'}, json=body)
    assert r.status_code == 200


def test_the_model_list_offers_only_chat_models(tmp_path: Path) -> None:
    """gpt-image-2 and embedding models are priced, but would fail as a chat pool, so they are not offered."""
    api, _ = lab(tmp_path)
    known = api.get("/api/model-failover/catalog", headers=LAB).json()["known_models"]
    assert SONNET in known and HAIKU in known and mc.GPT_PLACEHOLDER in known
    assert not [m for m in known if "image" in m or "embedding" in m]
