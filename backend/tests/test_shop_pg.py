"""The shop's database parts against a real PostgreSQL with pgvector (./tools/vector-db.sh): row-level security and the
agent's role, SET LOCAL scoping, the triggers, COPY and resumable upserts, FOR UPDATE SKIP LOCKED, LISTEN/NOTIFY and
the HNSW index. Each test gets its own throwaway schema (shop_test_<random>) and role, dropped afterwards, so no
other lab's tables are touched. Skipped, with the reason, when no database answers."""
from __future__ import annotations

import os
import secrets
import threading
import time
import uuid
from typing import Any, Iterator

import pytest

from backend.app.services import shop_data as D
from backend.app.services.shop_embedding import EmbedWorker
from backend.app.services.shop_schema import app_role
from backend.app.services.shop_store import Filters, PgShopStore
from backend.tests.test_assistant import LAB, Fake, reply, text, use
from backend.tests.test_shop import LAB_TAB, DIMS, FakeEmbedder, chat, events_for, make, of, sign_in, tool_results

URL = os.environ.get("LLM_LAB_PGVECTOR_URL") or "postgresql://lab:lab@127.0.0.1:5433/vectors"


def _reachable() -> str | None:
    try:
        import psycopg
    except ImportError:
        return "psycopg is not installed"
    try:
        with psycopg.connect(URL, connect_timeout=2) as conn:
            if not conn.execute("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'").fetchone():
                return "this PostgreSQL has no pgvector"
    except Exception as exc:  # noqa: BLE001
        return f"no PostgreSQL at {URL.rsplit('@', 1)[-1]} ({type(exc).__name__}); ./tools/vector-db.sh starts one"
    return None


SKIP = _reachable()
pytestmark = pytest.mark.skipif(SKIP is not None, reason=SKIP or "")


@pytest.fixture
def pg() -> Iterator[PgShopStore]:
    store = PgShopStore(URL, schema=f"shop_test_{secrets.token_hex(4)}")
    store.ensure(DIMS)
    try:
        yield store
    finally:
        store.close()
        store.drop()


def fill(store: PgShopStore, products: int = 1100, customers: int = 40, embed: bool = True) -> FakeEmbedder:
    store.upsert_products([D.generate_product(i) for i in range(products)])
    store.upsert_customers([D.generate_customer(j) for j in range(customers)])
    store.insert_orders([o for j in range(customers) for o in D.generate_orders(j, products)])
    embedder = FakeEmbedder()
    if embed:
        EmbedWorker(lambda: store, embedder, batch=256).drain()
    return embedder


def owner(store: PgShopStore, sql: str, *params: Any) -> list[tuple]:
    with store.pool.conn() as c:
        return c.execute(sql.replace("{s}", store.schema), params or None).fetchall()


# ----- row-level security and the agent's role -----
def test_row_level_security_keeps_each_shopper_to_their_own_rows(pg):
    fill(pg, products=200, embed=False)
    a, b = "c000003", "c000005"
    theirs = [r[0] for r in owner(pg, "SELECT id FROM {s}.orders WHERE customer_id = %s", b)]
    assert theirs
    with pg.shopper(a) as tx:
        assert tx.c.execute("SELECT current_user").fetchone()[0] == app_role(pg.schema)
        mine = tx.orders(50)
        assert mine and all(o["id"] not in theirs for o in mine)
        assert all(tx.orders(1, oid) == [] for oid in theirs)  # guessed ids find nothing
        assert tx.order_items(theirs) == []
        seen = tx.visible()
    assert seen == pg.owner_counts(a)
    with pg.shopper(None) as tx:
        assert not any(tx.visible().values())
    refused, why = pg.attempt_foreign_write(a, b)
    assert refused and "row-level security" in why


def test_set_local_does_not_leak_to_the_next_transaction(pg):
    fill(pg, products=50, embed=False)
    with pg.shopper("c000003") as tx:
        assert tx.visible()["orders"] >= 0
    with pg.pool.conn() as conn:  # the same pooled connection, outside any shopper transaction
        assert conn.execute("SELECT current_setting('app.customer_id', true)").fetchone()[0] in ("", None)
        assert conn.execute("SELECT current_user").fetchone()[0] != app_role(pg.schema)
    with pg.shopper(None) as tx:
        assert tx.visible()["orders"] == 0


def test_the_agents_role_cannot_change_prices_or_meta(pg):
    import psycopg

    fill(pg, products=20, embed=False)
    for sql in ("UPDATE {s}.products SET price_pence = 1", "UPDATE {s}.meta SET value = '0'",
                "DELETE FROM {s}.products", "UPDATE {s}.customers SET display_name = 'x'"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with pg.shopper("c000003") as tx:
                tx.c.execute(sql.replace("{s}", pg.schema))


def test_events_are_kept_apart_and_merges_are_idempotent_under_concurrency(pg):
    fill(pg, products=20, embed=False)
    batch = [D.clean_event(e) for e in events_for(("search", {"query": "tents"}),
                                                  ("view_category", {"category": "Outdoor"}))]

    def merge() -> None:
        with pg.shopper("c000003") as tx:
            tx.insert_events(batch)

    threads = [threading.Thread(target=merge) for _ in range(5)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert owner(pg, "SELECT count(*) FROM {s}.events WHERE customer_id = 'c000003'")[0][0] == 2
    with pg.shopper("c000004") as tx:
        assert tx.events(10) == [] and tx.delete_events() == 0
    assert owner(pg, "SELECT count(*) FROM {s}.events")[0][0] == 2


# ----- search -----
def test_hybrid_search_with_hnsw_is_in_a_fixed_order(pg):
    fill(pg)
    pg.build_index()
    assert pg.has_index()
    vector = FakeEmbedder().embed(["waterproof walking boots"], "query")[0]
    with pg.shopper(None) as tx:
        first = tx.search("waterproof walking boots", vector, Filters(), 12)
        again = tx.search("waterproof walking boots", vector, Filters(), 12)
        filtered = tx.search("boots", vector, Filters(max_price_pence=9000, size="9", in_stock_only=True), 12)
        plan = "\n".join(r[0] for r in tx.c.execute(
            f"EXPLAIN SELECT id FROM {pg.schema}.products ORDER BY embedding <=> %s::halfvec LIMIT 10",
            (str(vector),)).fetchall())
        products = tx.products([pid for pid, _ in filtered])
    assert first == again and len(first) == 12
    assert [s for _, s in first] == sorted((s for _, s in first), reverse=True)
    for (id1, s1), (id2, s2) in zip(first, first[1:]):
        assert s1 > s2 or id1 < id2  # equal scores come out by id
    assert filtered and all(p["price_pence"] <= 9000 and "9" in p["attributes"]["sizes"] and p["stock"] > 0
                            for p in products.values())
    assert "products_embedding" in plan


def test_the_databases_embed_text_is_exactly_pythons(pg):
    rows = [D.generate_product(i) for i in range(60)] + [{**D.generate_product(3), "id": "odd", "description": "",
                                                          "attributes": {"waterproof": False, "fit": "slim"}}]
    pg.upsert_products(rows)
    with pg.claim(100) as c:
        sql = {pid: (t, h) for pid, t, h in c.rows}
        c.done = []
    for r in rows:
        assert sql[r["id"]] == (D.embed_text(r), D.embed_hash(r)), r["id"]


# ----- keeping the index in step -----
def test_insert_pending_worker_done_and_found_by_meaning(pg):
    fill(pg, products=30)
    pg.add_product({"id": "new-1", "title": "Stormproof Tent", "brand": "Fellwick", "category": "Outdoor",
                    "subcategory": "Tents", "description": "Tent tent tent.", "attributes": {}, "price_pence": 9999,
                    "stock": 3, "rating": 4.0, "review_count": 0})
    assert owner(pg, "SELECT embed_state FROM {s}.products WHERE id = 'new-1'")[0][0] == "pending"
    worker = EmbedWorker(lambda: pg, FakeEmbedder())
    assert worker.drain() == 1
    state, model, at = owner(pg, "SELECT embed_state, embedded_with, embedded_at FROM {s}.products WHERE id='new-1'")[0]
    assert (state, model) == ("done", "ai/fake-embed") and at is not None
    vector = FakeEmbedder().embed(["tent"], "query")[0]
    with pg.shopper(None) as tx:
        assert tx.nearest(vector, [], Filters(), 1)[0][0] == "new-1"


def test_a_description_edit_re_embeds_and_a_price_edit_does_not(pg):
    fill(pg, products=20)
    worker = EmbedWorker(lambda: pg, FakeEmbedder())
    p = D.generate_product(5)
    hash_before = owner(pg, "SELECT embed_text_hash FROM {s}.products WHERE id = %s", p["id"])[0][0]
    version = int(pg.get_meta("data_version"))
    pg.update_product(p["id"], {**p, "price_pence": p["price_pence"] + 500, "stock": 1})
    state, h = owner(pg, "SELECT embed_state, embed_text_hash FROM {s}.products WHERE id = %s", p["id"])[0]
    assert (state, h) == ("done", hash_before) and worker.drain() == 0
    assert int(pg.get_meta("data_version")) > version  # a price change still moves the data version on
    pg.update_product(p["id"], {**p, "description": "Rewritten completely."})
    state, h, vec = owner(pg, "SELECT embed_state, embed_text_hash, embedding IS NOT NULL FROM {s}.products "
                              "WHERE id = %s", p["id"])[0]
    assert state == "pending" and h != hash_before and vec  # the last good vector stays meanwhile
    assert worker.drain() == 1


def test_two_workers_never_embed_the_same_row(pg):
    pg.upsert_products([D.generate_product(i) for i in range(400)])
    slow = FakeEmbedder()
    original = slow.embed
    slow.embed = lambda texts, kind="document": (time.sleep(0.03), original(texts, kind))[1]
    workers = [EmbedWorker(lambda: pg, slow, batch=25) for _ in range(4)]
    threads = [threading.Thread(target=w.drain) for w in workers]
    [t.start() for t in threads]
    [t.join() for t in threads]
    embedded = [t for batch in slow.calls for t in batch]
    assert len(embedded) == len(set(embedded)) == 400
    assert owner(pg, "SELECT count(*) FROM {s}.products WHERE embed_state = 'done'")[0][0] == 400


def test_a_failing_embed_backs_off_then_fails_and_retry_works(pg):
    pg.upsert_products([{**D.generate_product(1), "id": "bad", "description": "poison"}, D.generate_product(2)])
    embedder = FakeEmbedder(fail=lambda t: "poison" in t)
    worker = EmbedWorker(lambda: pg, embedder, backoff_s=0.0)
    for _ in range(10):
        worker.process_once()
    status = pg.embedding_status()
    assert status["failed"] == [{"id": "bad", "title": D.generate_product(1)["title"],
                                 "error": "RuntimeError: the embedding model rejected this text", "attempts": 5}]
    assert status["done"] == 1
    backoff = EmbedWorker(lambda: pg, embedder, backoff_s=60.0)
    pg.retry_failed(["bad"])
    backoff.process_once()  # attempt 1 fails; the next waits a minute
    assert owner(pg, "SELECT embed_next_at > now() + interval '50 seconds' FROM {s}.products WHERE id='bad'")[0][0]
    embedder.fail = None
    pg.retry_failed(None)
    assert worker.drain() == 1 and pg.embedding_status()["failed_count"] == 0


def test_a_model_change_marks_rows_for_re_embedding(pg):
    fill(pg, products=40)
    worker = EmbedWorker(lambda: pg, FakeEmbedder(model="ai/next-embed"))
    assert worker.check_model() == 40
    with pg.shopper(None) as tx:  # search still works on the old vectors meanwhile
        assert tx.search("tent", FakeEmbedder().embed(["tent"])[0], Filters(), 5)
    worker.drain()
    assert owner(pg, "SELECT DISTINCT embedded_with FROM {s}.products") == [("ai/next-embed",)]


def test_heavy_churn_rebuilds_the_index_concurrently(pg):
    fill(pg, products=100)
    pg.build_index()
    worker = EmbedWorker(lambda: pg, FakeEmbedder(model="ai/next-embed"), churn_share=2.0)  # no rebuild yet
    worker.check_model()
    worker.drain()  # every row gets a new vector: 100% churn
    assert pg.churn() == 100
    worker.churn_share = 0.2
    assert worker.maybe_reindex(wait=True) and pg.churn() == 0 and pg.has_index()
    assert not worker.maybe_reindex(wait=True)  # under the share now: nothing to do


def test_the_worker_wakes_on_notify_and_stops_cleanly(pg):
    fill(pg, products=5)
    worker = EmbedWorker(lambda: pg, FakeEmbedder(), poll_s=30.0)  # a poll would take 30 s: only NOTIFY is quick
    worker._model_checked = time.time()
    worker.start()
    time.sleep(0.5)
    pg.add_product({**D.generate_product(900), "id": "notified"})
    deadline = time.time() + 10
    while owner(pg, "SELECT embed_state FROM {s}.products WHERE id = 'notified'")[0][0] != "done":
        assert time.time() < deadline, "the worker did not wake on the notification"
        time.sleep(0.1)
    started = time.time()
    assert worker.stop(timeout_s=35) and time.time() - started < 35


def test_upserts_resume_without_duplicates_and_count_once(pg):
    rows = [D.generate_product(i) for i in range(300)]
    pg.upsert_products(rows[:200])
    pg.upsert_products(rows[100:])  # a batch sent again after a stop
    assert pg.counts()["products"] == 300
    orders = [o for j in range(10) for o in D.generate_orders(j, 300)]
    pg.upsert_customers([D.generate_customer(j) for j in range(10)])
    pg.insert_orders(orders)
    pg.insert_orders(orders)
    assert pg.counts()["orders"] == len(orders)


def test_a_file_is_applied_in_one_transaction(pg):
    import psycopg

    fill(pg, products=10, embed=False)
    before = pg.counts()["orders"]
    good = D.clean_order({"id": "imp-1", "customer_id": "c000001", "placed_at": "2026-11-01T10:00:00Z",
                          "items": [{"product_id": "p0000001", "quantity": 1, "price_pence": 100}]})
    clash = {**good, "id": "imp-2", "items": [{**good["items"][0], "id": "imp-1-0"}]}  # an item id already used
    with pytest.raises(psycopg.Error):
        pg.apply_file("orders", [good, {**clash, "items": [{**clash["items"][0], "quantity": 0}]}])
    assert pg.counts()["orders"] == before  # neither order went in


# ----- the whole service on the real database -----
@pytest.fixture
def live(pg, tmp_path):
    client, service, fake = make(tmp_path, products=0)
    service.use_store(pg)
    service.worker.backoff_s = 0.0
    fill(pg, products=1100, customers=40)
    pg.build_index()
    return client, service, fake


def test_checkout_through_confirm_on_the_real_database(live):
    client, service, _ = live
    h = sign_in(client)
    p = next(p for p in service.search("lamp", Filters(in_stock_only=True), 12) if not p["attributes"].get("sizes"))
    version = int(service.store.get_meta("data_version"))
    client.post("/api/shop/basket/items", headers=h, json={"product_id": p["id"], "quantity": 2})
    c = client.post("/api/shop/checkout", headers=h, json={"delivery": "next_day"}).json()
    r = client.post("/api/shop/confirm", headers=h, json={"confirmation_id": c["confirmation_id"], "accept": True})
    assert r.status_code == 200, r.text
    assert service.product(p["id"])["stock"] == p["stock"] - 2  # taken by the agent's role (UPDATE (stock) only)
    assert int(service.store.get_meta("data_version")) > version
    with service.store.shopper("c000003") as tx:
        assert any(e["type"] == "order_placed" for e in tx.events(5))
    assert client.post("/api/shop/confirm", headers=h, json={"confirmation_id": c["confirmation_id"],
                                                             "accept": True}).status_code == 409


def test_the_isolation_check_holds_on_the_real_database(live):
    client, _, _ = live
    r = client.post("/api/shop/isolation-check", headers=sign_in(client))
    attempts = r.json()["attempts"]
    assert len(attempts) >= 10 and all(a["ok"] for a in attempts), [a for a in attempts if not a["ok"]]
    write = next(a for a in attempts if a["name"] == "Write a row for another shopper")
    assert "row-level security" in write["detail"]


def test_profile_recommendations_and_forget_on_the_real_database(live):
    client, service, _ = live
    h = sign_in(client, "c000007")
    boots = [p["id"] for p in service.search("walking boots", Filters(subcategory="Walking boots"), 3)]
    client.post("/api/shop/events", headers=h, json={"events": events_for(
        *[("view_product", {"product_id": pid, "seconds": 60}) for pid in boots])})
    profile = client.get("/api/shop/profile", headers=h).json()
    assert profile["has_taste"] and profile["subcategories"][0]["subcategory"] == "Walking boots"
    recs = client.post("/api/shop/recommendations", headers=h, json={"limit": 6}).json()["items"]
    owned = {i["product_id"] for o in service.orders("c000007")["orders"] for i in o["items"]}
    assert recs and not {r["product"]["id"] for r in recs} & (owned | set(boots))
    assert client.delete("/api/shop/activity", headers=h).json()["deleted"] == len(boots)
    assert not client.get("/api/shop/profile", headers=h).json()["has_taste"]


def test_a_cached_answer_is_invalidated_by_a_product_change_on_the_real_database(live):
    client, service, fake = live

    def respond(params: dict) -> Any:
        if tool_results(params):
            return reply(text("Tents."))
        return reply(use("search_products", {"query": "tent"}))
    fake.respond = respond
    h = sign_in(client)
    first = chat(client, h, "two-person tent under £200")
    assert of(chat(client, h, "two-person tent under £200"), "cached")
    pid = of(first, "products")[0]["items"][0]["id"]
    client.patch(f"/api/shop/products/{pid}", headers=LAB_TAB, json={"stock": 7})  # the trigger moves the version on
    assert not of(chat(client, h, "two-person tent under £200"), "cached")


def test_two_checkouts_of_one_basket_confirmed_at_once_place_one_order(live):
    """Two confirmation cards for the same basket (two tabs), both pressed at the same moment: the basket lock makes
    the second wait, find the basket already ordered, and place nothing."""
    client, service, _ = live
    h = sign_in(client)
    p = next(p for p in service.search("mug", Filters(in_stock_only=True), 12) if not p["attributes"].get("sizes"))
    client.post("/api/shop/basket/items", headers=h, json={"product_id": p["id"], "quantity": 1})
    cards = [client.post("/api/shop/checkout", headers=h, json={"delivery": "standard"}).json() for _ in range(2)]
    before = len(service.orders("c000003", 50)["orders"])
    codes: list[int] = []
    barrier = threading.Barrier(2)

    def press(card: dict) -> None:
        barrier.wait()
        codes.append(client.post("/api/shop/confirm", headers=h, json={"confirmation_id": card["confirmation_id"],
                                                                       "accept": True}).status_code)

    threads = [threading.Thread(target=press, args=(c,)) for c in cards]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(codes) == [200, 409]
    assert len(service.orders("c000003", 50)["orders"]) == before + 1
    assert service.product(p["id"])["stock"] == p["stock"] - 1


def test_two_adds_at_once_make_one_line_and_keep_the_cap(live):
    """Finding 1, on PostgreSQL: concurrent adds of the same product take the basket lock in turn."""
    client, service, _ = live
    h = sign_in(client)
    p = next(p for p in service.search("lamp", Filters(in_stock_only=True), 24) if not p["attributes"].get("sizes"))
    barrier = threading.Barrier(2)
    codes: list[int] = []

    def add(quantity: int) -> None:
        barrier.wait()
        codes.append(client.post("/api/shop/basket/items", headers=h,
                                 json={"product_id": p["id"], "quantity": quantity}).status_code)

    for quantity, expect in ((1, [200, 200]), (15, [200, 400])):
        for item in service.basket("c000003")["items"]:
            service.remove_from_basket("c000003", item["id"])
        codes.clear()
        threads = [threading.Thread(target=add, args=(quantity,)) for _ in range(2)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        items = service.basket("c000003")["items"]
        assert sorted(codes) == expect
        assert [(i["product_id"], i["quantity"]) for i in items] == [(p["id"], 2 if quantity == 1 else 15)]
    with pytest.raises(Exception):  # the unique index and the cap are the database's own backstop
        with service.store.shopper("c000003") as tx:
            tx.add_basket_item("bi-x", p["id"], 10, None)


def test_an_existing_schema_is_brought_up_to_date(pg):
    """A schema made before the unique basket index gets it (duplicate lines merged) when a new process starts."""
    pg.upsert_customers([D.generate_customer(1)])
    pg.upsert_products([D.generate_product(1)])
    with pg.pool.conn() as c:
        c.execute(f"DROP INDEX {pg.schema}.basket_items_line")
        c.execute(f"UPDATE {pg.schema}.meta SET value = '1' WHERE key = 'schema_version'")
    for n in range(2):
        pg.plant_basket_item("c000001", "p0000001")
    fresh = PgShopStore(URL, schema=pg.schema)
    try:
        fresh.ensure()
        assert owner(pg, "SELECT quantity FROM {s}.basket_items") == [(2,)]
        assert owner(pg, "SELECT to_regclass('{s}.basket_items_line') IS NOT NULL")[0][0]
    finally:
        fresh.close()


# ----- the import lock and index builds -----
def test_the_import_lock_is_one_holder_across_connections_and_ends_with_its_connection(pg):
    """The backend and tools/shop-data.sh are separate processes with stores of their own: the advisory lock keeps
    them to one import at a time, and a process that dies lets it go with its connection."""
    other = PgShopStore(URL, schema=pg.schema)
    try:
        release = pg.try_job_lock()
        assert release is not None
        assert other.try_job_lock() is None
        release()
        theirs = other.try_job_lock()
        assert theirs is not None and pg.try_job_lock() is None
        theirs()
        again = pg.try_job_lock()
        assert again is not None
        again()
    finally:
        other.close()


def test_the_index_builds_without_workers_when_shared_memory_runs_out(pg, monkeypatch):
    """Docker's default 64 MB of shared memory is too little for a parallel build of a large graph (DiskFull): the
    build runs again with no workers, in one transaction, so nothing is left half made."""
    import psycopg

    fill(pg, products=300, customers=5)
    real = pg._build_index
    tries: list[bool] = []

    def build(parallel: bool) -> None:
        tries.append(parallel)
        if parallel:
            raise psycopg.errors.DiskFull("could not resize shared memory segment")
        real(parallel)
    monkeypatch.setattr(pg, "_build_index", build)
    pg.build_index()
    assert tries == [True, False] and pg.has_index()
    pg.reindex()  # a rebuild of an index that exists works too
    assert pg.has_index()


def invalid_copies(store: PgShopStore) -> list[str]:
    return [r[0] for r in owner(store, "SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
                                       "JOIN pg_namespace n ON n.oid = c.relnamespace "
                                       "WHERE n.nspname = %s AND NOT i.indisvalid", store.schema)]


def test_only_one_process_rebuilds_the_index_and_failed_copies_are_dropped(pg):
    """Found live: the backend's worker and the script both rebuilt after heavy churn, deadlocked, and left dozens of
    invalid copies that PostgreSQL kept updating on every write. Now a second rebuild is skipped, and copies a failed
    one left are dropped before the next."""
    import psycopg

    fill(pg, products=300, customers=5)
    pg.build_index()
    # What a failed concurrent build leaves: an invalid index (a unique one on a repeated column cannot be built).
    with psycopg.connect(URL, autocommit=True) as c:
        with pytest.raises(psycopg.errors.UniqueViolation):
            c.execute(f"CREATE UNIQUE INDEX CONCURRENTLY products_embedding_ccnew7 ON {pg.schema}.products (category)")
    assert invalid_copies(pg) == ["products_embedding_ccnew7"]
    with psycopg.connect(URL, autocommit=True) as other:  # another process mid-rebuild holds the lock
        other.execute("SELECT pg_advisory_lock(hashtext(%s))", (f"{pg.schema}.reindex",))
        assert pg.reindex() is False
        assert invalid_copies(pg) == ["products_embedding_ccnew7"]  # possibly its build in progress: left alone
        # It finishes. (Unlocked here rather than by closing: the server drops a closed session's locks a moment later.)
        other.execute("SELECT pg_advisory_unlock(hashtext(%s))", (f"{pg.schema}.reindex",))
    assert pg.reindex() is True
    assert invalid_copies(pg) == [] and pg.has_index()
    with pg.pool.conn() as c:  # the lock was let go
        assert c.execute("SELECT pg_try_advisory_lock(hashtext(%s))", (f"{pg.schema}.reindex",)).fetchone()[0]
        c.execute("SELECT pg_advisory_unlock(hashtext(%s))", (f"{pg.schema}.reindex",))


def test_two_stores_rebuilding_at_once_do_not_deadlock(pg):
    fill(pg, products=300, customers=5)
    pg.build_index()
    other = PgShopStore(URL, schema=pg.schema)
    results: list[Any] = []

    def rebuild(store: PgShopStore) -> None:
        try:
            results.append(store.reindex())
        except Exception as exc:  # noqa: BLE001
            results.append(exc)
    try:
        threads = [threading.Thread(target=rebuild, args=(s,)) for s in (pg, other)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
    finally:
        other.close()
    assert all(isinstance(r, bool) for r in results), results
    assert True in results and invalid_copies(pg) == []
