"""Where the shop's data lives: PostgreSQL with pgvector (PgShopStore), or memory for tests (MemoryShopStore).

Two kinds of access. The owner's methods on the store load and import data, keep the embeddings and the index, and
list the demo shoppers. Everything done for a shopper goes through `store.shopper(customer_id)`, one transaction as
that shopper: in PostgreSQL the transaction switches to the agent's role (no login, few grants) and sets
`app.customer_id`, so row-level security decides what it can see and write, and the SQL below never filters by
customer itself. `store.shopper(None)` is a guest: products only, no shopper rows. The memory store keeps the same rule
in code, so the same tests run against both.
"""
from __future__ import annotations

import copy
import json
import logging
import queue
import re
import secrets
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterator, Protocol

from ..gateways.pgvector import VectorDbUnavailable, connect, literal, where
from .shop_data import embed_hash, embed_text
from .shop_schema import (SCHEMA_VERSION, SHOPPER_TABLES, app_role, build_index_sql, channel, check_schema,
                          create_sql, drop_sql)

log = logging.getLogger("backend.shop")
DEFAULT_DIMS = 768
PROBE = "zz-isolation-probe"  # the isolation check's own shopper: never counted, listed or offered as "another shopper"
CANDIDATES = 50  # each half of a hybrid search ranks this many before they are fused
RRF_K = 60
PRODUCT_COLUMNS = ("id", "title", "brand", "category", "subcategory", "description", "attributes", "price_pence",
                   "stock", "rating", "review_count")


@dataclass
class Claimed:
    """Products claimed for embedding: held by this worker until the claim's block ends, when the results the worker
    put in `done` and `failed` are written back in the same transaction."""
    rows: list[tuple[str, str, str]]  # (id, text to embed, its hash)
    done: list[tuple[str, list[float]]] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)  # (id, error)
    model: str = ""
    max_attempts: int = 5
    backoff_s: float = 2.0
    replaced: int = 0  # products that had a vector already: churn, for the reindex


@dataclass
class Filters:
    category: str | None = None
    subcategory: str | None = None
    max_price_pence: int | None = None
    min_price_pence: int | None = None
    min_rating: float | None = None
    size: str | None = None
    colour: str | None = None
    in_stock_only: bool = False


def words_of(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", (text or "").lower())[:12]


def new_id(prefix: str) -> str:
    """Ids that sort by when they were made, so lists come out in the order things happened."""
    return f"{prefix}{int(time.time() * 1000):013d}{secrets.token_hex(3)}"


def _iso(v: Any) -> str:
    return v.isoformat() if isinstance(v, datetime) else str(v)


class ShopTx(Protocol):
    """One transaction as one shopper (or as a guest). There is no customer parameter: the transaction has one."""
    customer_id: str | None
    def products(self, ids: list[str]) -> dict[str, dict[str, Any]]: ...
    def embeddings(self, ids: list[str]) -> dict[str, list[float]]: ...
    def search(self, text: str, vector: list[float] | None, f: Filters, limit: int) -> list[tuple[str, float]]: ...
    def nearest(self, vector: list[float], exclude: list[str], f: Filters, limit: int) -> list[tuple[str, float]]: ...
    def top_rated(self, f: Filters, exclude: list[str], limit: int) -> list[str]: ...
    def take_stock(self, product_id: str, quantity: int) -> bool: ...
    def customer(self) -> dict[str, Any] | None: ...
    def lock_basket(self) -> None: ...
    def basket(self) -> tuple[str | None, list[dict[str, Any]]]: ...
    def add_basket_item(self, item_id: str, product_id: str, quantity: int, size: str | None) -> None: ...
    def set_basket_quantity(self, item_id: str, quantity: int) -> bool: ...
    def delete_basket_item(self, item_id: str) -> bool: ...
    def clear_basket(self) -> None: ...
    def set_offer(self, code: str | None) -> None: ...
    def orders(self, limit: int, order_id: str | None = None) -> list[dict[str, Any]]: ...
    def order_items(self, order_ids: list[str]) -> list[dict[str, Any]]: ...
    def order_item(self, item_id: str) -> dict[str, Any] | None: ...
    def insert_order(self, order: dict[str, Any], items: list[dict[str, Any]]) -> None: ...
    def offer_used(self, code: str) -> bool: ...
    def use_offer(self, code: str, order_id: str) -> None: ...
    def returns(self) -> list[dict[str, Any]]: ...
    def insert_return(self, row: dict[str, Any]) -> None: ...
    def wishlist(self) -> list[tuple[str, str]]: ...
    def add_wishlist(self, product_id: str) -> bool: ...
    def events(self, limit: int) -> list[dict[str, Any]]: ...
    def insert_events(self, rows: list[dict[str, Any]]) -> int: ...
    def delete_events(self) -> int: ...
    def taste(self) -> list[float] | None: ...
    def set_taste(self, vector: list[float] | None) -> None: ...
    def bump_state(self) -> None: ...
    def visible(self) -> dict[str, int]: ...


def rrf(*rankings: list[str], k: int = RRF_K) -> list[tuple[str, float]]:
    """Reciprocal rank fusion, ordered by score and then id, so equal scores always come out the same way."""
    scores: dict[str, float] = {}
    for ranking in rankings:
        for r, pid in enumerate(ranking, start=1):
            scores[pid] = scores.get(pid, 0.0) + 1.0 / (k + r)
    return sorted(scores.items(), key=lambda kv: (-round(kv[1], 12), kv[0]))


# ======================================================================================================== memory ====
class MemoryShopStore:
    """The store in memory, for tests: the same methods, and the same rule that a shopper's transaction sees and writes
    only that shopper's rows. A transaction takes the store's lock and is undone if it raises."""

    def __init__(self, dims: int = DEFAULT_DIMS, down: bool = False):
        self.dims, self.down = dims, down
        self.meta: dict[str, str] = {"data_version": "0", "dims": str(dims), "embed_model": ""}
        self.products_: dict[str, dict[str, Any]] = {}
        self.vectors: dict[str, list[float]] = {}
        self.rows: dict[str, list[dict[str, Any]]] = {t: [] for t in SHOPPER_TABLES}
        self.indexed = False
        self.reindexed = 0
        self.queue: dict[str, dict[str, Any]] = {}  # product id -> its embedding state, like the products' embed_* columns
        self.claimed: set[str] = set()  # rows a worker holds, like FOR UPDATE SKIP LOCKED
        self.notified = threading.Event()  # like LISTEN/NOTIFY
        self.lock = threading.RLock()
        self.job_lock = getattr(self, "job_lock", None) or threading.Lock()  # reset() calls __init__ again: keep it

    def _check(self) -> None:
        if self.down:
            raise VectorDbUnavailable("PostgreSQL did not answer. Start it with ./tools/vector-db.sh.")

    # ----- owner -----
    def status(self) -> dict[str, Any]:
        return {"available": not self.down, "message": "" if not self.down else "PostgreSQL did not answer.",
                "where": "memory"}

    def ensure(self, dims: int | None = None) -> None:
        self._check()

    def try_job_lock(self) -> Callable[[], None] | None:
        """Takes the one-import-at-a-time lock, like the database's advisory lock. Returns its release, or None."""
        self._check()
        return self.job_lock.release if self.job_lock.acquire(blocking=False) else None

    def reset(self, dims: int) -> None:
        self._check()
        with self.lock:
            version = int(self.meta["data_version"]) + 1
            self.__init__(dims)
            self.meta["data_version"] = str(version)

    def dims_(self) -> int:
        return int(self.meta["dims"])

    def get_meta(self, key: str) -> str:
        self._check()
        return self.meta.get(key, "")

    def set_meta(self, key: str, value: str) -> None:
        self.meta[key] = value

    def bump_data_version(self) -> int:
        with self.lock:
            self.meta["data_version"] = str(int(self.meta["data_version"]) + 1)
            return int(self.meta["data_version"])

    def approx_products(self) -> int:
        return len(self.products_)

    def counts(self) -> dict[str, int]:
        self._check()
        return {"products": len(self.products_),
                "customers": sum(1 for c in self.rows["customers"] if c["customer_id"] != PROBE),
                "orders": len(self.rows["orders"]), "embedded": len(self.vectors)}

    def upsert_products(self, rows: list[dict[str, Any]]) -> None:
        self._check()
        with self.lock:
            for r in rows:
                self.products_[r["id"]] = {k: copy.deepcopy(r[k]) for k in PRODUCT_COLUMNS}
                self._mark(r["id"])  # like the trigger: pending only when the embedded text changed
            if rows:
                self.bump_data_version()

    def update_product(self, product_id: str, changes: dict[str, Any]) -> bool:
        """Writes only the fields that changed, like the database's UPDATE of named columns."""
        with self.lock:
            if product_id not in self.products_:
                return False
            row = {**self.products_[product_id], **{k: copy.deepcopy(v) for k, v in changes.items()
                                                     if k in PRODUCT_COLUMNS and k != "id"}}
            self.upsert_products([row])
            return True

    def upsert_customers(self, rows: list[dict[str, Any]]) -> None:
        with self.lock:
            for r in rows:
                self.rows["customers"] = [c for c in self.rows["customers"] if c["customer_id"] != r["customer_id"]]
                self.rows["customers"].append({"customer_id": r["customer_id"], "display_name": r["display_name"],
                                               "sizes": dict(r.get("sizes") or {}),
                                               "preferences": dict(r.get("preferences") or {}),
                                               "email": r.get("email"), "state_version": 0, "taste": None})

    def insert_orders(self, orders: list[dict[str, Any]]) -> None:
        with self.lock:
            have = {o["id"] for o in self.rows["orders"]}
            for o in orders:
                if o["id"] in have:
                    continue
                self.rows["orders"].append({k: v for k, v in o.items() if k != "items"})
                for it in o["items"]:
                    self.rows["order_items"].append({**it, "customer_id": o["customer_id"], "order_id": o["id"]})

    def create_customer(self, row: dict[str, Any]) -> bool:
        with self.lock:
            if any(c["customer_id"] == row["customer_id"] for c in self.rows["customers"]):
                return False
            self.upsert_customers([row])
            return True

    def list_customers(self, limit: int) -> list[dict[str, Any]]:
        self._check()
        rows = sorted((c for c in self.rows["customers"] if c["customer_id"] != PROBE),
                      key=lambda c: c["customer_id"])[:limit]
        return [{"id": c["customer_id"], "display_name": c["display_name"]} for c in rows]

    def existing_customers(self, ids: list[str]) -> set[str]:
        have = {c["customer_id"] for c in self.rows["customers"]}
        return {i for i in ids if i in have}

    def existing_products(self, ids: list[str]) -> set[str]:
        self._check()
        return {i for i in ids if i in self.products_}

    def categories(self) -> set[str]:
        return {p["category"] for p in self.products_.values()}

    # ----- the embedding queue -----
    def _mark(self, pid: str) -> None:
        q = self.queue.setdefault(pid, {"hash": None, "state": "pending", "attempts": 0, "error": None, "next_at": 0.0,
                                        "embedded_with": None, "embedded_at": None})
        h = embed_hash(self.products_[pid])
        if q["hash"] != h or q["state"] == "new":
            q.update(hash=h, state="pending", attempts=0, error=None, next_at=0.0)
            self.notified.set()

    @contextmanager
    def claim(self, limit: int) -> Iterator[Claimed]:
        """Up to `limit` pending products nobody else holds: first attempts in a batch, a retried one on its own so a
        product that keeps failing cannot hold back the rest. Writes the results when the block ends."""
        now = time.time()
        with self.lock:
            ready = sorted(pid for pid, q in self.queue.items() if q["state"] == "pending" and q["next_at"] <= now
                           and pid not in self.claimed and pid in self.products_)
            fresh = [pid for pid in ready if self.queue[pid]["attempts"] == 0][:limit]
            ids = fresh or [pid for pid in ready if self.queue[pid]["attempts"] > 0][:1]
            self.claimed |= set(ids)
            c = Claimed([(pid, embed_text(self.products_[pid]), self.queue[pid]["hash"]) for pid in ids])
        try:
            yield c
            self._finish(c)
        finally:
            with self.lock:
                self.claimed -= set(ids)

    def _finish(self, c: Claimed) -> None:
        with self.lock:
            for pid, v in c.done:
                q = self.queue.get(pid)
                if q is None or pid not in self.products_:
                    continue
                c.replaced += pid in self.vectors
                self.vectors[pid] = list(v)
                q.update(state="done", attempts=0, error=None, embedded_with=c.model,
                         embedded_at=datetime.now(timezone.utc).isoformat())
            for pid, error in c.failed:
                q = self.queue.get(pid)
                if q is None:
                    continue
                q["attempts"] += 1
                q["error"] = error[:500]
                q["state"] = "failed" if q["attempts"] >= c.max_attempts else "pending"
                q["next_at"] = time.time() + c.backoff_s * 2 ** (q["attempts"] - 1)
            if c.done:
                self.meta["embed_model"] = c.model
                self.bump_data_version()
            self.meta["churn_rows"] = str(int(self.meta.get("churn_rows", "0")) + c.replaced)

    def embedding_status(self, limit: int = 50) -> dict[str, Any]:
        with self.lock:
            states = [q["state"] for pid, q in self.queue.items() if pid in self.products_]
            failed = sorted((pid for pid, q in self.queue.items() if q["state"] == "failed" and pid in self.products_))
            return {"pending": states.count("pending"), "done": states.count("done"), "failed_count": len(failed),
                    "failed": [{"id": pid, "title": self.products_[pid]["title"], "error": self.queue[pid]["error"],
                                "attempts": self.queue[pid]["attempts"]} for pid in failed[:limit]]}

    def retry_failed(self, ids: list[str] | None) -> int:
        with self.lock:
            n = 0
            for pid, q in self.queue.items():  # failed ones, and ones waiting out a backoff
                if (q["state"] == "failed" or (q["state"] == "pending" and q["attempts"])) and (ids is None or pid in ids):
                    q.update(state="pending", attempts=0, error=None, next_at=0.0)
                    n += 1
            if n:
                self.notified.set()
            return n

    def mark_model(self, model: str, limit: int = 5000) -> int:
        """Products embedded with another model go back in the queue; their old vectors serve searches meanwhile."""
        with self.lock:
            ids = sorted(pid for pid, q in self.queue.items() if q["state"] == "done" and q["embedded_with"] != model)
            for pid in ids[:limit]:
                self.queue[pid].update(state="pending", attempts=0, error=None, next_at=0.0)
            return len(ids[:limit])

    def embed_states(self, ids: list[str]) -> dict[str, dict[str, Any]]:
        """Where each product is in the embedding queue, for the Lab's product editor."""
        with self.lock:
            return {i: {"embed_state": q["state"], "embedded_at": q["embedded_at"], "embedded_with": q["embedded_with"],
                        "embed_error": q["error"]} for i, q in self.queue.items() if i in ids}

    def churn(self) -> int:
        return int(self.meta.get("churn_rows", "0"))

    def has_index(self) -> bool:
        return self.indexed

    def reindex(self) -> bool:
        self.reindexed += 1
        self.meta["churn_rows"] = "0"
        return True

    def close(self) -> None:
        """Nothing to let go of: the same method as the database store, so callers need not ask."""

    def wait_for_change(self, timeout_s: float) -> bool:
        woke = self.notified.wait(timeout_s)
        self.notified.clear()
        return woke

    # ----- editing products -----
    def get_products_owner(self, ids: list[str]) -> dict[str, dict[str, Any]]:
        return {i: copy.deepcopy(self.products_[i]) for i in ids if i in self.products_}

    def add_product(self, row: dict[str, Any]) -> bool:
        with self.lock:
            if row["id"] in self.products_:
                return False
            self.upsert_products([row])
            return True

    def delete_product(self, product_id: str) -> bool:
        with self.lock:
            if self.products_.pop(product_id, None) is None:
                return False
            self.vectors.pop(product_id, None)
            self.queue.pop(product_id, None)
            for t in ("basket_items", "wishlists"):
                self.rows[t] = [r for r in self.rows[t] if r["product_id"] != product_id]
            self.meta["churn_rows"] = str(self.churn() + 1)
            self.bump_data_version()
            return True

    def build_index(self) -> None:
        self.indexed = True
        self.meta["churn_rows"] = "0"

    def prune_events(self, days: int) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        with self.lock:
            before = len(self.rows["events"])
            self.rows["events"] = [e for e in self.rows["events"] if datetime.fromisoformat(e["ts"]) >= cutoff]
            return before - len(self.rows["events"])

    def foreign_sample(self, customer_id: str) -> dict[str, str | None]:
        """Another shopper's ids, read as the owner, for the isolation check to try (and fail) to reach."""
        def first(table: str, key: str) -> str | None:
            rows = sorted((r for r in self.rows[table] if r["customer_id"] not in (customer_id, PROBE)),
                          key=lambda r: r[key])
            return rows[0][key] if rows else None
        other = first("customers", "customer_id")
        return {"customer_id": other, "order_id": first("orders", "id"), "order_item_id": first("order_items", "id"),
                "basket_item_id": first("basket_items", "id")}

    def plant_basket_item(self, customer_id: str, product_id: str) -> str:
        """Puts an item in a shopper's basket as the owner (the isolation check's target, and tests)."""
        with self.lock:
            item_id = new_id("bi")
            self.rows["basket_items"].append({"customer_id": customer_id, "id": item_id, "product_id": product_id,
                                              "quantity": 1, "size": None})
            return item_id

    def unplant(self, item_id: str) -> None:
        with self.lock:
            self.rows["basket_items"] = [r for r in self.rows["basket_items"] if r["id"] != item_id]

    def remove_customer(self, customer_id: str) -> None:
        with self.lock:
            for t in SHOPPER_TABLES:
                self.rows[t] = [r for r in self.rows[t] if r["customer_id"] != customer_id]

    def owner_counts(self, customer_id: str) -> dict[str, int]:
        return {t: sum(1 for r in self.rows[t] if r["customer_id"] == customer_id) for t in SHOPPER_TABLES}

    def attempt_foreign_write(self, customer_id: str, other: str) -> tuple[bool, str]:
        """The memory store's transactions set customer_id themselves, so there is no way to name another shopper."""
        with self.shopper(customer_id) as tx:
            tx.add_wishlist("p-isolation-check")
            wrote = any(r["customer_id"] == other and r["product_id"] == "p-isolation-check"
                        for r in self.rows["wishlists"])
            self.rows["wishlists"] = [r for r in self.rows["wishlists"] if r["product_id"] != "p-isolation-check"]
        return not wrote, "memory store: rows always take the transaction's shopper"

    def apply_file(self, kind: str, rows: list[dict[str, Any]]) -> None:
        with self.lock:
            {"products": self.upsert_products, "customers": self.upsert_customers,
             "orders": self.insert_orders}[kind](rows)

    @contextmanager
    def shopper(self, customer_id: str | None) -> Iterator["MemoryTx"]:
        self._check()
        with self.lock:
            saved = copy.deepcopy(self.rows), {k: v["stock"] for k, v in self.products_.items()}
            try:
                yield MemoryTx(self, customer_id or None)
            except BaseException:
                self.rows = saved[0]
                for k, stock in saved[1].items():
                    if k in self.products_:
                        self.products_[k]["stock"] = stock
                raise


class MemoryTx:
    def __init__(self, store: MemoryShopStore, customer_id: str | None):
        self.s, self.customer_id = store, customer_id

    def _mine(self, table: str) -> list[dict[str, Any]]:
        if not self.customer_id:
            return []
        return [r for r in self.s.rows[table] if r["customer_id"] == self.customer_id]

    def _need(self) -> str:
        if not self.customer_id:
            raise PermissionError("no shopper in this transaction")
        return self.customer_id

    # ----- products -----
    def products(self, ids: list[str]) -> dict[str, dict[str, Any]]:
        return {i: copy.deepcopy(self.s.products_[i]) for i in ids if i in self.s.products_}

    def embeddings(self, ids: list[str]) -> dict[str, list[float]]:
        return {i: list(self.s.vectors[i]) for i in ids if i in self.s.vectors}

    def _match(self, p: dict[str, Any], f: Filters) -> bool:
        a = p["attributes"] or {}
        return ((not f.category or p["category"] == f.category) and (not f.subcategory or p["subcategory"] == f.subcategory)
                and (f.max_price_pence is None or p["price_pence"] <= f.max_price_pence)
                and (f.min_price_pence is None or p["price_pence"] >= f.min_price_pence)
                and (f.min_rating is None or float(p["rating"]) >= f.min_rating)
                and (not f.size or f.size in (a.get("sizes") or []))
                and (not f.colour or f.colour.lower() in str(a.get("colour", "")).lower())
                and (not f.in_stock_only or p["stock"] > 0))

    def search(self, text: str, vector: list[float] | None, f: Filters, limit: int) -> list[tuple[str, float]]:
        pool = [p for p in self.s.products_.values() if self._match(p, f)]
        words = set(words_of(text))
        rankings = []
        if vector is not None:
            scored = sorted(((sum(x * y for x, y in zip(vector, self.s.vectors[p["id"]])), p["id"]) for p in pool
                             if p["id"] in self.s.vectors), key=lambda t: (-t[0], t[1]))
            rankings.append([pid for _, pid in scored[:CANDIDATES]])
        if words:
            def stems(t: str) -> set[str]:
                return {w.rstrip("s") for w in words_of(t)} | set(words_of(t))
            stem_words = {w.rstrip("s") for w in words}
            scored = []
            for p in pool:
                have = stems(f"{p['title']} {p['brand']} {p['subcategory']} {p['description']}")
                hits = len(stem_words & have)
                if hits:
                    scored.append((hits, p["id"]))
            scored.sort(key=lambda t: (-t[0], t[1]))
            rankings.append([pid for _, pid in scored[:CANDIDATES]])
        if not rankings:
            ordered = sorted(pool, key=lambda p: (-float(p["rating"]), -p["review_count"], p["id"]))
            return [(p["id"], 0.0) for p in ordered[:limit]]
        return rrf(*rankings)[:limit]

    def nearest(self, vector: list[float], exclude: list[str], f: Filters, limit: int) -> list[tuple[str, float]]:
        ex = set(exclude)
        scored = [(1 - sum(x * y for x, y in zip(vector, self.s.vectors[p["id"]])), p["id"])
                  for p in self.s.products_.values() if p["id"] in self.s.vectors and p["id"] not in ex
                  and self._match(p, f)]
        return [(pid, d) for d, pid in sorted(scored, key=lambda t: (t[0], t[1]))[:limit]]

    def top_rated(self, f: Filters, exclude: list[str], limit: int) -> list[str]:
        ex = set(exclude)
        pool = [p for p in self.s.products_.values() if p["id"] not in ex and self._match(p, f)]
        return [p["id"] for p in sorted(pool, key=lambda p: (-float(p["rating"]), -p["review_count"], p["id"]))[:limit]]

    def take_stock(self, product_id: str, quantity: int) -> bool:
        p = self.s.products_.get(product_id)
        self.s.bump_data_version()  # like the statement trigger, which fires for any stock update
        if not p or p["stock"] < quantity:
            return False
        p["stock"] -= quantity
        return True

    # ----- the shopper's own rows -----
    def customer(self) -> dict[str, Any] | None:
        rows = self._mine("customers")
        if not rows:
            return None
        c = rows[0]
        return {"customer_id": c["customer_id"], "display_name": c["display_name"], "sizes": dict(c["sizes"]),
                "preferences": dict(c["preferences"]), "state_version": c["state_version"],
                "has_taste": c.get("taste") is not None}

    def lock_basket(self) -> None:
        """The memory store's transactions already run one at a time."""

    def basket(self) -> tuple[str | None, list[dict[str, Any]]]:
        b = self._mine("baskets")
        items = sorted(self._mine("basket_items"), key=lambda r: r["id"])
        return (b[0]["offer_code"] if b else None), [{k: r[k] for k in ("id", "product_id", "quantity", "size")}
                                                     for r in items]

    def add_basket_item(self, item_id: str, product_id: str, quantity: int, size: str | None) -> None:
        same = next((r for r in self._mine("basket_items") if r["product_id"] == product_id
                     and (r["size"] or "") == (size or "")), None)
        if same is not None:  # like the unique index's upsert
            if same["quantity"] + quantity > 20:
                raise ValueError("quantity over 20")
            same["quantity"] += quantity
            return
        self.s.rows["basket_items"].append({"customer_id": self._need(), "id": item_id, "product_id": product_id,
                                            "quantity": quantity, "size": size})

    def set_basket_quantity(self, item_id: str, quantity: int) -> bool:
        for r in self._mine("basket_items"):
            if r["id"] == item_id:
                r["quantity"] = quantity
                return True
        return False

    def delete_basket_item(self, item_id: str) -> bool:
        mine = [r for r in self._mine("basket_items") if r["id"] == item_id]
        for r in mine:
            self.s.rows["basket_items"].remove(r)
        return bool(mine)

    def clear_basket(self) -> None:
        for r in self._mine("basket_items"):
            self.s.rows["basket_items"].remove(r)

    def set_offer(self, code: str | None) -> None:
        b = self._mine("baskets")
        if b:
            b[0]["offer_code"] = code
        else:
            self.s.rows["baskets"].append({"customer_id": self._need(), "offer_code": code})

    def orders(self, limit: int, order_id: str | None = None) -> list[dict[str, Any]]:
        rows = [dict(r) for r in self._mine("orders") if order_id is None or r["id"] == order_id]
        return sorted(rows, key=lambda r: (r["placed_at"], r["id"]), reverse=True)[:limit]

    def order_items(self, order_ids: list[str]) -> list[dict[str, Any]]:
        ids = set(order_ids)
        return sorted((dict(r) for r in self._mine("order_items") if r["order_id"] in ids),
                      key=lambda r: (r["order_id"], r["id"]))

    def order_item(self, item_id: str) -> dict[str, Any] | None:
        for r in self._mine("order_items"):
            if r["id"] == item_id:
                o = next(o for o in self._mine("orders") if o["id"] == r["order_id"])
                return {**r, "status": o["status"], "placed_at": o["placed_at"]}
        return None

    def insert_order(self, order: dict[str, Any], items: list[dict[str, Any]]) -> None:
        cid = self._need()
        if any(o["id"] == order["id"] for o in self.s.rows["orders"]):
            raise ValueError("duplicate order id")
        self.s.rows["orders"].append({**order, "customer_id": cid})
        for it in items:
            self.s.rows["order_items"].append({**it, "customer_id": cid, "order_id": order["id"]})

    def offer_used(self, code: str) -> bool:
        return any(r["code"] == code for r in self._mine("offers_used"))

    def use_offer(self, code: str, order_id: str) -> None:
        self.s.rows["offers_used"].append({"customer_id": self._need(), "code": code, "order_id": order_id})

    def returns(self) -> list[dict[str, Any]]:
        return sorted((dict(r) for r in self._mine("returns")), key=lambda r: (r["created_at"], r["id"]), reverse=True)

    def insert_return(self, row: dict[str, Any]) -> None:
        self.s.rows["returns"].append({**row, "customer_id": self._need()})

    def wishlist(self) -> list[tuple[str, str]]:
        rows = sorted(self._mine("wishlists"), key=lambda r: (r["added_at"], r["product_id"]), reverse=True)
        return [(r["product_id"], r["added_at"]) for r in rows]

    def add_wishlist(self, product_id: str) -> bool:
        if any(r["product_id"] == product_id for r in self._mine("wishlists")):
            return False
        self.s.rows["wishlists"].append({"customer_id": self._need(), "product_id": product_id,
                                         "added_at": datetime.now(timezone.utc).isoformat()})
        return True

    def events(self, limit: int) -> list[dict[str, Any]]:
        rows = sorted(self._mine("events"), key=lambda r: (r["ts"], r["event_id"]), reverse=True)[:limit]
        return [{k: copy.deepcopy(r[k]) for k in ("event_id", "type", "props", "page", "ts")} for r in rows]

    def insert_events(self, rows: list[dict[str, Any]]) -> int:
        cid = self._need()
        have = {r["event_id"] for r in self._mine("events")}
        added = 0
        for r in rows:
            if r["event_id"] not in have:
                self.s.rows["events"].append({**copy.deepcopy(r), "customer_id": cid,
                                              "received_at": datetime.now(timezone.utc).isoformat()})
                have.add(r["event_id"])
                added += 1
        return added

    def delete_events(self) -> int:
        mine = self._mine("events")
        for r in mine:
            self.s.rows["events"].remove(r)
        return len(mine)

    def taste(self) -> list[float] | None:
        rows = self._mine("customers")
        return list(rows[0]["taste"]) if rows and rows[0].get("taste") is not None else None

    def set_taste(self, vector: list[float] | None) -> None:
        for r in self._mine("customers"):
            r["taste"] = list(vector) if vector is not None else None

    def bump_state(self) -> None:
        for r in self._mine("customers"):
            r["state_version"] += 1

    def visible(self) -> dict[str, int]:
        return {t: len(self._mine(t)) for t in SHOPPER_TABLES}


# ====================================================================================================== postgres ====
class _Pool:
    """A few open connections, reused: a new one per query would cost more than the query."""

    def __init__(self, connect: Any, size: int = 8):
        self.connect, self.size = connect, size
        self.idle: queue.LifoQueue = queue.LifoQueue()

    @contextmanager
    def conn(self) -> Iterator[Any]:
        import psycopg

        conn = None
        while conn is None:
            try:
                conn = self.idle.get_nowait()
            except queue.Empty:
                conn = self.connect()
                break
            if conn.closed or conn.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
                conn.close()
                conn = None
        try:
            yield conn
        except BaseException:
            conn.close()  # a failed connection may be in any state: never reuse it
            raise
        else:
            if conn.info.transaction_status == psycopg.pq.TransactionStatus.IDLE and self.idle.qsize() < self.size:
                self.idle.put(conn)
            else:
                conn.close()

    def close(self) -> None:
        while True:
            try:
                self.idle.get_nowait().close()
            except queue.Empty:
                return


def _vec(text: str | None) -> list[float] | None:
    return json.loads(text) if text else None


class _Undo(Exception):
    pass


class PgShopStore:
    def __init__(self, url: str, schema: str = "shop", connect_timeout_s: int = 3):
        self.url, self.schema, self.connect_timeout_s = url, check_schema(schema), connect_timeout_s
        self.role = app_role(schema)
        self.pool = _Pool(self._connect)
        self._listener: Any = None
        self._ready = False
        self._lock = threading.Lock()

    def _connect(self) -> Any:
        return connect(self.url, self.connect_timeout_s, autocommit=True)

    def try_job_lock(self) -> Callable[[], None] | None:
        """Takes the shop's import lock, a PostgreSQL advisory lock on a connection of its own, so the backend and
        tools/shop-data.sh (or two backends) never generate or import into the same schema at once. The lock lasts as
        long as that connection: the returned function closes it, and a process that dies drops it with its
        connection. None when another process holds it."""
        conn = self._connect()
        try:
            got = conn.execute("SELECT pg_try_advisory_lock(hashtext(%s))", (f"{self.schema}.import",)).fetchone()[0]
        except Exception:
            conn.close()
            raise
        if not got:
            conn.close()
            return None
        return conn.close

    @contextmanager
    def _owner(self) -> Iterator[Any]:
        """One transaction as the connecting user: the loader, which every shopper table's `_loader` policy admits."""
        self.ensure()
        with self.pool.conn() as conn, conn.transaction():
            yield conn

    # ----- owner -----
    def status(self) -> dict[str, Any]:
        try:
            with self.pool.conn() as conn:
                conn.execute("SELECT 1")
            return {"available": True, "message": "", "where": where(self.url)}
        except VectorDbUnavailable as exc:
            return {"available": False, "message": str(exc), "where": where(self.url) if self.url else ""}
        except Exception as exc:  # the info route must not fail
            return {"available": False, "message": f"{type(exc).__name__}: {exc}", "where": where(self.url)}

    def ensure(self, dims: int | None = None) -> None:
        if self._ready:
            return
        import psycopg

        with self._lock, self.pool.conn() as conn:
            if self._ready:
                return
            exists = conn.execute("SELECT to_regclass(%s)", (f"{self.schema}.meta",)).fetchone()[0]
            version = None
            if exists is not None:
                row = conn.execute(f"SELECT value FROM {self.schema}.meta WHERE key = 'schema_version'").fetchone()
                version = row[0] if row else None
                dims = int(conn.execute(f"SELECT value FROM {self.schema}.meta WHERE key = 'dims'").fetchone()[0])
            if version != SCHEMA_VERSION:  # new, or made by an older version of this code: bring it up to date
                try:
                    with conn.transaction():
                        conn.execute(create_sql(self.schema, dims or DEFAULT_DIMS))
                except psycopg.errors.FeatureNotSupported as exc:
                    raise VectorDbUnavailable("This PostgreSQL has no pgvector extension. Use the pgvector/pgvector "
                                              "image (./tools/vector-db.sh).") from exc
            self._ready = True

    def reset(self, dims: int) -> None:
        """Drops and remakes the shop's schema (a new generated shop). The data version carries on upwards."""
        version = 0
        try:
            version = int(self.get_meta("data_version") or 0)
        except Exception:  # noqa: BLE001  (no schema yet)
            pass
        with self._lock, self.pool.conn() as conn, conn.transaction():
            conn.execute(drop_sql(self.schema))
            conn.execute(create_sql(self.schema, dims))
            conn.execute(f"UPDATE {self.schema}.meta SET value = %s WHERE key = 'data_version'", (str(version + 1),))
            self._ready = True

    def drop(self) -> None:
        with self.pool.conn() as conn, conn.transaction():
            conn.execute(drop_sql(self.schema))
        self._ready = False
        self.pool.close()

    def dims_(self) -> int:
        return int(self.get_meta("dims") or DEFAULT_DIMS)

    def get_meta(self, key: str) -> str:
        with self._owner() as c:
            row = c.execute(f"SELECT value FROM {self.schema}.meta WHERE key = %s", (key,)).fetchone()
            return row[0] if row else ""

    def set_meta(self, key: str, value: str) -> None:
        with self._owner() as c:
            c.execute(f"INSERT INTO {self.schema}.meta VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = "
                      "EXCLUDED.value", (key, value))

    def bump_data_version(self) -> int:
        with self._owner() as c:
            return int(c.execute(f"UPDATE {self.schema}.meta SET value = (value::int + 1)::text WHERE key = "
                                 "'data_version' RETURNING value").fetchone()[0])

    def approx_products(self) -> int:
        """PostgreSQL's own estimate of the product count (no scan of a million rows), for thresholds where a few
        per cent does not matter. A table never analysed has no estimate yet (-1), so that one is counted."""
        with self._owner() as c:
            n = c.execute("SELECT reltuples::bigint FROM pg_class WHERE oid = %s::regclass",
                          (f"{self.schema}.products",)).fetchone()[0]
            if n is None or n < 0:
                n = c.execute(f"SELECT count(*) FROM {self.schema}.products").fetchone()[0]
            return int(n)

    def counts(self) -> dict[str, int]:
        s = self.schema
        with self._owner() as c:
            row = c.execute(f"SELECT (SELECT count(*) FROM {s}.products), "
                            f"(SELECT count(*) FROM {s}.customers WHERE customer_id <> %(probe)s), "
                            f"(SELECT count(*) FROM {s}.orders), "
                            f"(SELECT count(*) FROM {s}.products WHERE embedding IS NOT NULL)",
                            {"probe": PROBE}).fetchone()
        return {"products": row[0], "customers": row[1], "orders": row[2], "embedded": row[3]}

    def _copy_products(self, c: Any, rows: list[dict[str, Any]], bulk: bool = True) -> None:
        """COPY into a temporary table, then one upsert: COPY is the fast way in, and the upsert lets a batch that
        was half done when a run stopped be sent again. The trigger marks new and reworded products pending (an
        unchanged one keeps its vector); in bulk, one notification for the batch instead of one per row."""
        s = self.schema
        c.execute("CREATE TEMP TABLE IF NOT EXISTS shop_load (id text, title text, brand text, category text, "
                  "subcategory text, description text, attributes jsonb, price_pence int, stock int, rating numeric, "
                  "review_count int) ON COMMIT DELETE ROWS")
        with c.cursor().copy("COPY shop_load FROM STDIN") as cp:
            for r in rows:
                cp.write_row([r["id"], r["title"], r["brand"], r["category"], r["subcategory"], r["description"],
                              json.dumps(r["attributes"]), r["price_pence"], r["stock"], r["rating"],
                              r["review_count"]])
        if bulk:
            c.execute("SELECT set_config('shop.bulk', 'on', true)")
        c.execute(f"""INSERT INTO {s}.products AS p (id, title, brand, category, subcategory, description, attributes,
                        price_pence, stock, rating, review_count)
                      SELECT DISTINCT ON (id) * FROM shop_load ORDER BY id
                      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, brand = EXCLUDED.brand,
                        category = EXCLUDED.category, subcategory = EXCLUDED.subcategory,
                        description = EXCLUDED.description, attributes = EXCLUDED.attributes,
                        price_pence = EXCLUDED.price_pence, stock = EXCLUDED.stock, rating = EXCLUDED.rating,
                        review_count = EXCLUDED.review_count""")
        if bulk:
            c.execute("SELECT set_config('shop.bulk', 'off', true)")
            c.execute("SELECT pg_notify(%s, 'batch')", (channel(s),))

    def upsert_products(self, rows: list[dict[str, Any]]) -> None:
        with self._owner() as c:
            self._copy_products(c, rows)

    def _customers(self, c: Any, rows: list[dict[str, Any]]) -> None:
        c.cursor().executemany(
            f"INSERT INTO {self.schema}.customers (customer_id, display_name, sizes, preferences, email) "
            "VALUES (%s, %s, %s, %s, %s) ON CONFLICT (customer_id) DO UPDATE SET display_name = EXCLUDED.display_name, "
            "sizes = EXCLUDED.sizes, preferences = EXCLUDED.preferences, email = EXCLUDED.email",
            [(r["customer_id"], r["display_name"], json.dumps(r.get("sizes") or {}),
              json.dumps(r.get("preferences") or {}), r.get("email")) for r in rows])

    def upsert_customers(self, rows: list[dict[str, Any]]) -> None:
        with self._owner() as c:
            self._customers(c, rows)

    def _orders(self, c: Any, orders: list[dict[str, Any]]) -> None:
        s = self.schema
        cur = c.cursor()
        cur.executemany(
            f"INSERT INTO {s}.orders (id, customer_id, placed_at, status, delivery, offer_code, subtotal_pence, "
            "discount_pence, delivery_pence, total_pence) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (id) DO NOTHING",
            [(o["id"], o["customer_id"], o["placed_at"], o["status"], o["delivery"], o.get("offer_code"),
              o["subtotal_pence"], o["discount_pence"], o["delivery_pence"], o["total_pence"]) for o in orders])
        cur.executemany(
            f"INSERT INTO {s}.order_items (id, customer_id, order_id, product_id, quantity, size, price_pence) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (id) DO NOTHING",
            [(it["id"], o["customer_id"], o["id"], it["product_id"], it["quantity"], it.get("size"),
              it["price_pence"]) for o in orders for it in o["items"]])

    def insert_orders(self, orders: list[dict[str, Any]]) -> None:
        with self._owner() as c:
            self._orders(c, orders)

    def create_customer(self, row: dict[str, Any]) -> bool:
        with self._owner() as c:
            cur = c.execute(f"INSERT INTO {self.schema}.customers (customer_id, display_name, sizes, preferences, "
                            "email) VALUES (%s, %s, '{}', '{}', %s) ON CONFLICT (customer_id) DO NOTHING",
                            (row["customer_id"], row["display_name"], row.get("email")))
            return cur.rowcount == 1

    def list_customers(self, limit: int) -> list[dict[str, Any]]:
        with self._owner() as c:
            rows = c.execute(f"SELECT customer_id, display_name FROM {self.schema}.customers WHERE customer_id <> %s "
                             "ORDER BY customer_id LIMIT %s", (PROBE, limit)).fetchall()
        return [{"id": r[0], "display_name": r[1]} for r in rows]

    def existing_customers(self, ids: list[str]) -> set[str]:
        with self._owner() as c:
            return {r[0] for r in c.execute(f"SELECT customer_id FROM {self.schema}.customers WHERE customer_id = "
                                            "ANY(%s)", (list(ids),)).fetchall()}

    def existing_products(self, ids: list[str]) -> set[str]:
        with self._owner() as c:
            return {r[0] for r in c.execute(f"SELECT id FROM {self.schema}.products WHERE id = ANY(%s)",
                                            (list(ids),)).fetchall()}

    def categories(self) -> set[str]:
        with self._owner() as c:
            return {r[0] for r in c.execute(f"SELECT DISTINCT category FROM {self.schema}.products").fetchall()}

    # ----- the embedding queue -----
    @contextmanager
    def claim(self, limit: int) -> Iterator[Claimed]:
        """Up to `limit` pending products, locked FOR UPDATE SKIP LOCKED for the rest of this transaction, so two workers
        (two backend processes, or the import and the worker) never embed the same product. First attempts go in a
        batch; a retried product goes on its own, so one that keeps failing cannot hold back the rest."""
        s = self.schema
        with self._owner() as c:
            rows = c.execute(f"""SELECT id, {s}.embed_text(title, brand, category, subcategory, description, attributes),
                    embed_text_hash FROM {s}.products WHERE embed_state = 'pending' AND embed_attempts = 0
                    ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (limit,)).fetchall()
            if not rows:
                rows = c.execute(f"""SELECT id, {s}.embed_text(title, brand, category, subcategory, description,
                        attributes), embed_text_hash FROM {s}.products WHERE embed_state = 'pending'
                        AND embed_attempts > 0 AND (embed_next_at IS NULL OR embed_next_at <= now())
                        ORDER BY embed_next_at NULLS FIRST, id LIMIT 1 FOR UPDATE SKIP LOCKED""").fetchall()
            claimed = Claimed([(r[0], r[1], r[2]) for r in rows])
            yield claimed
            self._finish(c, claimed)

    def _finish(self, c: Any, claimed: Claimed) -> None:
        s = self.schema
        model = claimed.model
        if claimed.done:
            c.execute("CREATE TEMP TABLE IF NOT EXISTS shop_vec (id text, v text) ON COMMIT DELETE ROWS")
            with c.cursor().copy("COPY shop_vec FROM STDIN") as cp:
                for pid, v in claimed.done:
                    cp.write_row([pid, literal(v)])
            churn = c.execute(f"SELECT count(*) FROM {s}.products WHERE id = ANY(%s) AND embedding IS NOT NULL",
                              ([pid for pid, _ in claimed.done],)).fetchone()[0]
            c.execute(f"""UPDATE {s}.products p SET embedding = t.v::halfvec, embed_state = 'done', embed_attempts = 0,
                    embed_error = NULL, embed_next_at = NULL, embedded_at = now(), embedded_with = %s
                    FROM shop_vec t WHERE p.id = t.id""", (model,))
            c.execute(f"INSERT INTO {s}.meta VALUES ('embed_model', %s) ON CONFLICT (key) DO UPDATE SET value = "
                      "EXCLUDED.value", (model,))
            c.execute(f"INSERT INTO {s}.meta VALUES ('churn_rows', %s) ON CONFLICT (key) DO UPDATE SET value = "
                      f"({s}.meta.value::bigint + EXCLUDED.value::bigint)::text", (str(churn),))
            # New vectors change what a search finds, so answers made before them are stale.
            c.execute(f"UPDATE {s}.meta SET value = (value::bigint + 1)::text WHERE key = 'data_version'")
            claimed.replaced = churn
        for pid, error in claimed.failed:
            c.execute(f"""UPDATE {s}.products SET embed_attempts = embed_attempts + 1, embed_error = %s,
                    embed_state = CASE WHEN embed_attempts + 1 >= %s THEN 'failed' ELSE 'pending' END,
                    embed_next_at = now() + make_interval(secs => %s * power(2, embed_attempts))
                    WHERE id = %s""", (error[:500], claimed.max_attempts, claimed.backoff_s, pid))

    def embedding_status(self, limit: int = 50) -> dict[str, Any]:
        s = self.schema
        with self._owner() as c:
            counts = dict(c.execute(f"SELECT embed_state, count(*) FROM {s}.products GROUP BY 1").fetchall())
            failed = c.execute(f"SELECT id, title, embed_error, embed_attempts FROM {s}.products WHERE embed_state = "
                               "'failed' ORDER BY id LIMIT %s", (limit,)).fetchall()
        return {"pending": counts.get("pending", 0), "done": counts.get("done", 0),
                "failed_count": counts.get("failed", 0),
                "failed": [{"id": r[0], "title": r[1], "error": r[2], "attempts": r[3]} for r in failed]}

    def retry_failed(self, ids: list[str] | None) -> int:
        """Failed products, and ones waiting out a backoff, go back in the queue now with a fresh count."""
        s = self.schema
        with self._owner() as c:
            n = c.execute(f"UPDATE {s}.products SET embed_state = 'pending', embed_attempts = 0, embed_error = NULL, "
                          "embed_next_at = NULL WHERE (embed_state = 'failed' OR (embed_state = 'pending' AND "
                          "embed_attempts > 0)) AND (%(ids)s::text[] IS NULL OR "
                          "id = ANY(%(ids)s::text[]))", {"ids": ids}).rowcount
            if n:
                c.execute("SELECT pg_notify(%s, 'retry')", (channel(s),))
        return n

    def mark_model(self, model: str, limit: int = 5000) -> int:
        s = self.schema
        with self._owner() as c:
            return c.execute(f"""UPDATE {s}.products SET embed_state = 'pending', embed_attempts = 0, embed_error = NULL,
                    embed_next_at = NULL WHERE id IN (SELECT id FROM {s}.products WHERE embed_state = 'done'
                    AND embedded_with IS DISTINCT FROM %s ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED)""",
                             (model, limit)).rowcount

    def embed_states(self, ids: list[str]) -> dict[str, dict[str, Any]]:
        """Where each product is in the embedding queue, for the Lab's product editor."""
        with self._owner() as c:
            rows = c.execute(f"SELECT id, embed_state, embedded_at, embedded_with, embed_error FROM {self.schema}.products "
                             "WHERE id = ANY(%s)", (list(ids),)).fetchall()
        return {r[0]: {"embed_state": r[1], "embedded_at": _iso(r[2]) if r[2] else None, "embedded_with": r[3],
                       "embed_error": r[4]} for r in rows}

    def churn(self) -> int:
        return int(self.get_meta("churn_rows") or 0)

    def has_index(self) -> bool:
        with self._owner() as c:
            return c.execute("SELECT to_regclass(%s)", (f"{self.schema}.products_embedding",)).fetchone()[0] is not None

    def build_index(self) -> None:
        """Builds the HNSW index. PostgreSQL builds it with parallel workers, which share its graph through shared
        memory; Docker gives a container 64 MB of that unless told otherwise (tools/vector-db.sh asks for 1 GB), and a
        large graph does not fit. Then it builds again with no workers, in the server's own memory: slower, but it
        works on any server."""
        import psycopg

        try:
            self._build_index(parallel=True)
        except psycopg.errors.DiskFull:
            log.warning("Shop: not enough shared memory for a parallel index build; building without workers.")
            self._build_index(parallel=False)

    def _build_index(self, parallel: bool) -> None:
        with self._owner() as c:
            c.execute("SET LOCAL maintenance_work_mem = '512MB'")
            if not parallel:
                c.execute("SET LOCAL max_parallel_maintenance_workers = 0")
            c.execute(build_index_sql(self.schema))
            c.execute(f"INSERT INTO {self.schema}.meta VALUES ('churn_rows', '0') ON CONFLICT (key) DO UPDATE SET "
                      "value = '0'")

    def reindex(self) -> bool:
        """Rebuilds the HNSW index without blocking reads or writes (CONCURRENTLY cannot run in a transaction).
        Only one process rebuilds at a time: the backend's worker and tools/shop-data.sh both start one after heavy
        churn, and two concurrent rebuilds of one index deadlock. So it holds an advisory lock on its connection and
        returns False, doing nothing, when another process holds it. A rebuild that fails leaves an invalid copy
        (`products_embedding_ccnew…`) that PostgreSQL keeps updating on every write; with the lock held none can be
        another process's build in progress, so any left over are dropped first, and its own is dropped if it fails.
        Like build_index, it tries again without parallel workers when shared memory runs out."""
        import psycopg

        self.ensure()
        with self.pool.conn() as conn:
            key = f"{self.schema}.reindex"
            if not conn.execute("SELECT pg_try_advisory_lock(hashtext(%s))", (key,)).fetchone()[0]:
                return False
            try:
                self._drop_leftover_builds(conn)
                try:
                    conn.execute(f"REINDEX INDEX CONCURRENTLY {self.schema}.products_embedding")
                except psycopg.errors.DiskFull:
                    log.warning("Shop: not enough shared memory for a parallel reindex; rebuilding without workers.")
                    self._drop_leftover_builds(conn)
                    conn.execute("SET max_parallel_maintenance_workers = 0")
                    try:
                        conn.execute(f"REINDEX INDEX CONCURRENTLY {self.schema}.products_embedding")
                    finally:
                        conn.execute("RESET max_parallel_maintenance_workers")
                except Exception:
                    self._drop_leftover_builds(conn)
                    raise
                conn.execute(f"INSERT INTO {self.schema}.meta VALUES ('churn_rows', '0') ON CONFLICT (key) DO UPDATE "
                             "SET value = '0'")
                return True
            finally:
                conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (key,))

    def _drop_leftover_builds(self, conn: Any) -> int:
        """Drops the invalid index copies failed concurrent rebuilds left behind. Call it holding the reindex lock."""
        names = [r[0] for r in conn.execute(
            "SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
            "JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = %s AND NOT i.indisvalid AND c.relname LIKE 'products\\_embedding\\_ccnew%%'",
            (self.schema,)).fetchall()]
        for name in names:
            conn.execute(f'DROP INDEX CONCURRENTLY IF EXISTS {self.schema}."{name}"')
        if names:
            log.info("Shop: dropped %d invalid index copies left by failed rebuilds.", len(names))
        return len(names)

    def wait_for_change(self, timeout_s: float) -> bool:
        """Waits on LISTEN for the trigger's notification, up to `timeout_s`. A dedicated connection, kept open."""
        conn = self._listener
        if conn is None or conn.closed:
            conn = self._listener = self._connect()
            conn.execute(f"LISTEN {channel(self.schema)}")
        woke = False
        for _ in conn.notifies(timeout=timeout_s, stop_after=1):
            woke = True
        return woke

    def close(self) -> None:
        if self._listener is not None and not self._listener.closed:
            self._listener.close()
        self._listener = None
        self.pool.close()

    # ----- editing products -----
    def get_products_owner(self, ids: list[str]) -> dict[str, dict[str, Any]]:
        with self.shopper(None) as tx:
            return tx.products(ids)

    def add_product(self, row: dict[str, Any]) -> bool:
        with self._owner() as c:
            if c.execute(f"SELECT 1 FROM {self.schema}.products WHERE id = %s", (row["id"],)).fetchone():
                return False
            self._copy_products(c, [row], bulk=False)
            return True

    def update_product(self, product_id: str, changes: dict[str, Any]) -> bool:
        """Writes only the columns that changed, so an edit never puts back a stock level a checkout has just taken."""
        allowed = [k for k in PRODUCT_COLUMNS if k != "id" and k in changes]
        if not allowed:
            return bool(self.existing_products([product_id]))
        sets = ", ".join(f"{k} = %({k})s" for k in allowed)
        values = {k: json.dumps(changes[k]) if k == "attributes" else changes[k] for k in allowed}
        with self._owner() as c:
            cur = c.execute(f"UPDATE {self.schema}.products SET {sets} WHERE id = %(id)s", {**values, "id": product_id})
            return cur.rowcount == 1

    def delete_product(self, product_id: str) -> bool:
        s = self.schema
        with self._owner() as c:
            n = c.execute(f"DELETE FROM {s}.products WHERE id = %s", (product_id,)).rowcount
            if n:
                c.execute(f"DELETE FROM {s}.basket_items WHERE product_id = %s", (product_id,))
                c.execute(f"DELETE FROM {s}.wishlists WHERE product_id = %s", (product_id,))
                c.execute(f"INSERT INTO {s}.meta VALUES ('churn_rows', '1') ON CONFLICT (key) DO UPDATE SET value = "
                          f"({s}.meta.value::bigint + 1)::text")
            return n == 1

    def prune_events(self, days: int) -> int:
        with self._owner() as c:
            return c.execute(f"DELETE FROM {self.schema}.events WHERE ts < now() - make_interval(days => %s)",
                             (days,)).rowcount

    def foreign_sample(self, customer_id: str) -> dict[str, str | None]:
        s = self.schema
        with self._owner() as c:
            def one(sql: str) -> str | None:
                row = c.execute(sql.replace("<> %s", "<> ALL(%s)"), ([customer_id, PROBE],)).fetchone()
                return row[0] if row else None
            return {"customer_id": one(f"SELECT customer_id FROM {s}.customers WHERE customer_id <> %s ORDER BY 1 LIMIT 1"),
                    "order_id": one(f"SELECT id FROM {s}.orders WHERE customer_id <> %s ORDER BY 1 LIMIT 1"),
                    "order_item_id": one(f"SELECT id FROM {s}.order_items WHERE customer_id <> %s ORDER BY 1 LIMIT 1"),
                    "basket_item_id": one(f"SELECT id FROM {s}.basket_items WHERE customer_id <> %s ORDER BY 1 LIMIT 1")}

    def plant_basket_item(self, customer_id: str, product_id: str) -> str:
        item_id = new_id("bi")
        with self._owner() as c:
            c.execute(f"INSERT INTO {self.schema}.basket_items (id, customer_id, product_id, quantity) VALUES "
                      "(%s, %s, %s, 1)", (item_id, customer_id, product_id))
        return item_id

    def unplant(self, item_id: str) -> None:
        with self._owner() as c:
            c.execute(f"DELETE FROM {self.schema}.basket_items WHERE id = %s", (item_id,))

    def remove_customer(self, customer_id: str) -> None:
        """Every row of one shopper (the isolation check's probe), in one transaction."""
        with self._owner() as c:
            for t in reversed(SHOPPER_TABLES):
                c.execute(f"DELETE FROM {self.schema}.{t} WHERE customer_id = %s", (customer_id,))

    def owner_counts(self, customer_id: str) -> dict[str, int]:
        with self._owner() as c:
            return {t: c.execute(f"SELECT count(*) FROM {self.schema}.{t} WHERE customer_id = %s",
                                 (customer_id,)).fetchone()[0] for t in SHOPPER_TABLES}

    def attempt_foreign_write(self, customer_id: str, other: str) -> tuple[bool, str]:
        """As the agent's role, with this shopper set, tries to write a row that names another shopper. The policy's
        WITH CHECK must refuse it. Nothing is kept either way (the savepoint is rolled back)."""
        import psycopg

        with self.shopper(customer_id) as tx:
            try:
                with tx.c.transaction():  # a savepoint
                    tx.c.execute(f"INSERT INTO {self.schema}.wishlists (customer_id, product_id) VALUES (%s, %s)",
                                 (other, "p-isolation-check"))
                    raise _Undo()
            except psycopg.errors.InsufficientPrivilege as exc:
                return True, str(exc).splitlines()[0]
            except _Undo:
                return False, "the database accepted the row (rolled back)"
        return False, ""

    def apply_file(self, kind: str, rows: list[dict[str, Any]]) -> None:
        """A whole imported file in one transaction: all of it, or (on any error) none of it."""
        with self._owner() as c:
            if kind == "products":
                self._copy_products(c, rows)
            elif kind == "customers":
                self._customers(c, rows)
            else:
                self._orders(c, rows)

    @contextmanager
    def shopper(self, customer_id: str | None) -> Iterator["PgTx"]:
        self.ensure()
        with self.pool.conn() as conn, conn.transaction():
            conn.execute(f"SET LOCAL ROLE {self.role}")
            conn.execute("SELECT set_config('app.customer_id', %s, true)", (customer_id or "",))
            yield PgTx(conn, self.schema, customer_id or None)


class PgTx:
    """The shopper's transaction. No query here names a customer: row-level security supplies it."""

    def __init__(self, conn: Any, schema: str, customer_id: str | None):
        self.c, self.s, self.customer_id = conn, schema, customer_id

    def _q(self, sql: str, params: Any = None) -> list[tuple]:
        return self.c.execute(sql.replace("{s}", self.s), params).fetchall()

    def _x(self, sql: str, params: Any = None) -> int:
        return self.c.execute(sql.replace("{s}", self.s), params).rowcount

    # ----- products -----
    def products(self, ids: list[str]) -> dict[str, dict[str, Any]]:
        if not ids:
            return {}
        rows = self._q(f"SELECT {', '.join(PRODUCT_COLUMNS[:-2])}, rating::float8, review_count FROM {{s}}.products "
                       "WHERE id = ANY(%s)", (list(ids),))
        return {r[0]: dict(zip(PRODUCT_COLUMNS, r)) for r in rows}

    def embeddings(self, ids: list[str]) -> dict[str, list[float]]:
        if not ids:
            return {}
        return {r[0]: _vec(r[1]) for r in self._q("SELECT id, embedding::text FROM {s}.products WHERE id = ANY(%s) "
                                                  "AND embedding IS NOT NULL", (list(ids),))}

    @staticmethod
    def _where(f: Filters, p: dict[str, Any]) -> str:
        conds = ["true"]
        for name, sql in (("category", "p.category = %(category)s"), ("subcategory", "p.subcategory = %(subcategory)s"),
                          ("max_price_pence", "p.price_pence <= %(max_price_pence)s"),
                          ("min_price_pence", "p.price_pence >= %(min_price_pence)s"),
                          ("min_rating", "p.rating >= %(min_rating)s"),
                          ("size", "p.attributes->'sizes' ? %(size)s"),
                          ("colour", "position(lower(%(colour)s) in lower(coalesce(p.attributes->>'colour', ''))) > 0")):
            value = getattr(f, name)
            if value not in (None, ""):
                p[name] = value
                conds.append(sql)
        if f.in_stock_only:
            conds.append("p.stock > 0")
        return " AND ".join(conds)

    def _hnsw(self) -> None:
        # With a filter, the index keeps scanning until enough rows pass it, in order (pgvector 0.8's iterative scan).
        self.c.execute("SET LOCAL hnsw.ef_search = 100")
        self.c.execute("SET LOCAL hnsw.iterative_scan = strict_order")

    def search(self, text: str, vector: list[float] | None, f: Filters, limit: int) -> list[tuple[str, float]]:
        p: dict[str, Any] = {"k": CANDIDATES, "limit": limit}
        cond = self._where(f, p)
        words = words_of(text)
        parts = []
        if vector is not None:
            self._hnsw()
            p["v"] = literal(vector)
            parts.append(f"""SELECT id, row_number() OVER (ORDER BY d, id) AS r FROM (
                  SELECT p.id, p.embedding <=> %(v)s::halfvec AS d FROM {{s}}.products p
                  WHERE p.embedding IS NOT NULL AND {cond} ORDER BY p.embedding <=> %(v)s::halfvec LIMIT %(k)s) sem""")
        if words:
            p["q"] = " | ".join(words)
            parts.append(f"""SELECT id, row_number() OVER (ORDER BY rank DESC, id) AS r FROM (
                  SELECT p.id, ts_rank_cd(p.tsv, q) AS rank FROM {{s}}.products p, to_tsquery('english', %(q)s) q
                  WHERE p.tsv @@ q AND {cond} ORDER BY ts_rank_cd(p.tsv, q) DESC, p.id LIMIT %(k)s) kw""")
        if not parts:
            rows = self._q(f"SELECT p.id FROM {{s}}.products p WHERE {cond} ORDER BY p.rating DESC, p.review_count DESC,"
                           " p.id LIMIT %(limit)s", p)
            return [(r[0], 0.0) for r in rows]
        union = " UNION ALL ".join(f"({x})" for x in parts)
        rows = self._q(f"SELECT id, round(sum(1.0 / ({RRF_K} + r)), 12)::float8 AS score FROM ({union}) fused "
                       "GROUP BY id ORDER BY score DESC, id LIMIT %(limit)s", p)
        return [(r[0], r[1]) for r in rows]

    def nearest(self, vector: list[float], exclude: list[str], f: Filters, limit: int) -> list[tuple[str, float]]:
        self._hnsw()
        p: dict[str, Any] = {"v": literal(vector), "ex": list(exclude), "limit": limit}
        cond = self._where(f, p)
        rows = self._q(f"SELECT p.id, (p.embedding <=> %(v)s::halfvec)::float8 FROM {{s}}.products p WHERE "
                       f"p.embedding IS NOT NULL AND NOT (p.id = ANY(%(ex)s)) AND {cond} "
                       "ORDER BY p.embedding <=> %(v)s::halfvec LIMIT %(limit)s", p)
        return sorted(((r[0], r[1]) for r in rows), key=lambda t: (t[1], t[0]))

    def top_rated(self, f: Filters, exclude: list[str], limit: int) -> list[str]:
        p: dict[str, Any] = {"ex": list(exclude), "limit": limit}
        cond = self._where(f, p)
        return [r[0] for r in self._q(f"SELECT p.id FROM {{s}}.products p WHERE NOT (p.id = ANY(%(ex)s)) AND {cond} "
                                      "ORDER BY p.rating DESC, p.review_count DESC, p.id LIMIT %(limit)s", p)]

    def take_stock(self, product_id: str, quantity: int) -> bool:
        return self._x("UPDATE {s}.products SET stock = stock - %s WHERE id = %s AND stock >= %s",
                       (quantity, product_id, quantity)) == 1

    # ----- the shopper's own rows -----
    def customer(self) -> dict[str, Any] | None:
        rows = self._q("SELECT customer_id, display_name, sizes, preferences, state_version, taste IS NOT NULL "
                       "FROM {s}.customers")
        if not rows:
            return None
        r = rows[0]
        return {"customer_id": r[0], "display_name": r[1], "sizes": r[2], "preferences": r[3], "state_version": r[4],
                "has_taste": r[5]}

    def lock_basket(self) -> None:
        """Holds this shopper's basket for the rest of the transaction, so two checkouts (two tabs, two confirmation
        cards) run one after the other: the second then finds the basket already ordered."""
        self.c.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"{self.s}:basket:{self.customer_id}",))

    def basket(self) -> tuple[str | None, list[dict[str, Any]]]:
        offer = self._q("SELECT offer_code FROM {s}.baskets")
        rows = self._q("SELECT id, product_id, quantity, size FROM {s}.basket_items ORDER BY id")
        return (offer[0][0] if offer else None), [dict(zip(("id", "product_id", "quantity", "size"), r)) for r in rows]

    def add_basket_item(self, item_id: str, product_id: str, quantity: int, size: str | None) -> None:
        """Adds a line, or adds to the line for the same product and size (the unique index is the backstop for the
        basket lock; a total over 20 fails the column's check rather than slipping through)."""
        self._x("INSERT INTO {s}.basket_items (id, product_id, quantity, size) VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (customer_id, product_id, (coalesce(size, ''))) DO UPDATE SET quantity = "
                "{s}.basket_items.quantity + EXCLUDED.quantity", (item_id, product_id, quantity, size))

    def set_basket_quantity(self, item_id: str, quantity: int) -> bool:
        return self._x("UPDATE {s}.basket_items SET quantity = %s WHERE id = %s", (quantity, item_id)) == 1

    def delete_basket_item(self, item_id: str) -> bool:
        return self._x("DELETE FROM {s}.basket_items WHERE id = %s", (item_id,)) == 1

    def clear_basket(self) -> None:
        self._x("DELETE FROM {s}.basket_items")

    def set_offer(self, code: str | None) -> None:
        self._x("INSERT INTO {s}.baskets (offer_code) VALUES (%s) ON CONFLICT (customer_id) DO UPDATE SET "
                "offer_code = EXCLUDED.offer_code", (code,))

    ORDER_COLS = ("id", "placed_at", "status", "delivery", "offer_code", "subtotal_pence", "discount_pence",
                  "delivery_pence", "total_pence")

    def orders(self, limit: int, order_id: str | None = None) -> list[dict[str, Any]]:
        where_ = "WHERE id = %(id)s" if order_id is not None else ""
        rows = self._q(f"SELECT {', '.join(self.ORDER_COLS)} FROM {{s}}.orders {where_} ORDER BY placed_at DESC, id DESC "
                       "LIMIT %(limit)s", {"id": order_id, "limit": limit})
        return [{**dict(zip(self.ORDER_COLS, r)), "placed_at": _iso(r[1])} for r in rows]

    ITEM_COLS = ("id", "order_id", "product_id", "quantity", "size", "price_pence")

    def order_items(self, order_ids: list[str]) -> list[dict[str, Any]]:
        if not order_ids:
            return []
        rows = self._q(f"SELECT {', '.join(self.ITEM_COLS)} FROM {{s}}.order_items WHERE order_id = ANY(%s) "
                       "ORDER BY order_id, id", (list(order_ids),))
        return [dict(zip(self.ITEM_COLS, r)) for r in rows]

    def order_item(self, item_id: str) -> dict[str, Any] | None:
        rows = self._q("SELECT i.id, i.order_id, i.product_id, i.quantity, i.size, i.price_pence, o.status, o.placed_at "
                       "FROM {s}.order_items i JOIN {s}.orders o ON o.id = i.order_id WHERE i.id = %s", (item_id,))
        if not rows:
            return None
        r = rows[0]
        return {**dict(zip(self.ITEM_COLS, r[:6])), "status": r[6], "placed_at": _iso(r[7])}

    def insert_order(self, order: dict[str, Any], items: list[dict[str, Any]]) -> None:
        self._x("INSERT INTO {s}.orders (id, placed_at, status, delivery, offer_code, subtotal_pence, discount_pence, "
                "delivery_pence, total_pence) VALUES (%(id)s, %(placed_at)s, %(status)s, %(delivery)s, %(offer_code)s, "
                "%(subtotal_pence)s, %(discount_pence)s, %(delivery_pence)s, %(total_pence)s)", order)
        self.c.cursor().executemany(
            f"INSERT INTO {self.s}.order_items (id, order_id, product_id, quantity, size, price_pence) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            [(it["id"], order["id"], it["product_id"], it["quantity"], it.get("size"), it["price_pence"])
             for it in items])

    def offer_used(self, code: str) -> bool:
        return bool(self._q("SELECT 1 FROM {s}.offers_used WHERE code = %s", (code,)))

    def use_offer(self, code: str, order_id: str) -> None:
        self._x("INSERT INTO {s}.offers_used (code, order_id) VALUES (%s, %s)", (code, order_id))

    def returns(self) -> list[dict[str, Any]]:
        rows = self._q("SELECT id, order_item_id, reason, status, created_at FROM {s}.returns "
                       "ORDER BY created_at DESC, id DESC")
        return [{"id": r[0], "order_item_id": r[1], "reason": r[2], "status": r[3], "created_at": _iso(r[4])}
                for r in rows]

    def insert_return(self, row: dict[str, Any]) -> None:
        self._x("INSERT INTO {s}.returns (id, order_item_id, reason, status, created_at) VALUES "
                "(%(id)s, %(order_item_id)s, %(reason)s, %(status)s, %(created_at)s)", row)

    def wishlist(self) -> list[tuple[str, str]]:
        return [(r[0], _iso(r[1])) for r in self._q("SELECT product_id, added_at FROM {s}.wishlists "
                                                    "ORDER BY added_at DESC, product_id DESC")]

    def add_wishlist(self, product_id: str) -> bool:
        return self._x("INSERT INTO {s}.wishlists (product_id) VALUES (%s) ON CONFLICT DO NOTHING", (product_id,)) == 1

    def events(self, limit: int) -> list[dict[str, Any]]:
        rows = self._q("SELECT event_id::text, type, props, page, ts FROM {s}.events ORDER BY ts DESC, event_id DESC "
                       "LIMIT %s", (limit,))
        return [{"event_id": r[0], "type": r[1], "props": r[2], "page": r[3], "ts": _iso(r[4])} for r in rows]

    def insert_events(self, rows: list[dict[str, Any]]) -> int:
        if not rows:
            return 0
        out = self._q("INSERT INTO {s}.events (event_id, type, props, page, ts) "
                      "SELECT * FROM unnest(%s::uuid[], %s::text[], %s::jsonb[], %s::text[], %s::timestamptz[]) "
                      "ON CONFLICT (customer_id, event_id) DO NOTHING RETURNING 1",
                      ([r["event_id"] for r in rows], [r["type"] for r in rows],
                       [json.dumps(r["props"]) for r in rows], [r["page"] for r in rows], [r["ts"] for r in rows]))
        return len(out)

    def delete_events(self) -> int:
        return self._x("DELETE FROM {s}.events")

    def taste(self) -> list[float] | None:
        rows = self._q("SELECT taste::text FROM {s}.customers")
        return _vec(rows[0][0]) if rows else None

    def set_taste(self, vector: list[float] | None) -> None:
        self._x("UPDATE {s}.customers SET taste = %s::halfvec, taste_updated_at = now()",
                (literal(vector) if vector is not None else None,))

    def bump_state(self) -> None:
        self._x("UPDATE {s}.customers SET state_version = state_version + 1")

    def visible(self) -> dict[str, int]:
        return {t: self._q(f"SELECT count(*) FROM {{s}}.{t}")[0][0] for t in SHOPPER_TABLES}
