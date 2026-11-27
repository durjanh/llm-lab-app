"""Filling the shop: the seeded generator (20,000, 100,000 or 1,000,000 products) and imports of a person's own files.

One job at a time. A generated shop loads in phases (products, customers, orders, embedding, index) and records its
place in generated/shop/import.json after every batch, so a run that was stopped, or cut off by a restart, carries on
from that batch when the same size is generated again. Products go in with COPY in batches of 5,000; the trigger marks
each pending and the embedding worker (shop_embedding) embeds them; the HNSW index is built once, after the bulk load.

An imported file is checked row by row first. Any rejected row refuses the whole file, with each row's reason, and
nothing is applied; a file that passes goes in as one transaction.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from ..core.errors import ApiError
from ..gateways.pgvector import VectorDbUnavailable
from . import shop_data as D
from .shop_embedding import EmbedWorker

log = logging.getLogger("backend.shop")
PRODUCT_BATCH = 5000
CUSTOMER_BATCH = 2000
ORDER_CUSTOMERS = 500
MAX_FILE_BYTES = 200 * 2**20
MAX_REJECTED_SHOWN = 50
PHASES = ("products", "customers", "orders", "embedding", "index", "done")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ShopImporter:
    def __init__(self, store: Callable[[], Any], worker: EmbedWorker, state_path: Path, embedder: Any,
                 product_batch: int = PRODUCT_BATCH):
        self.store, self.worker, self.path, self.embedder = store, worker, state_path, embedder
        self.product_batch = product_batch
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._state = self._load()  # the generation: its phase and row, so a stopped run can carry on
        self.file_path = state_path.with_name("import-file.json")
        self._file: dict[str, Any] = self._load_file()  # the last file import's result, kept apart from it

    # ----- state -----
    def _load(self) -> dict[str, Any]:
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"state": "idle", "done": 0, "total": 0, "message": "", "phase": None}
        if state.get("state") == "running":  # the server stopped part-way: it can carry on from here
            state["state"] = "stopped"
            state["message"] = ("Stopped part-way when the server restarted. Generate the same size again to carry on "
                                f"from {state.get('phase')} (row {state.get('cursor', 0):,}).")
        return state

    def _load_file(self) -> dict[str, Any]:
        try:
            return json.loads(self.file_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_file(self, state: dict[str, Any]) -> None:
        self._file = {**state, "updated_at": _now()}
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.file_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._file, indent=1), encoding="utf-8")
        tmp.replace(self.file_path)

    def resumable(self, size: int) -> bool:
        """True when a generation of this size stopped part-way and generating it again carries on."""
        s = self._state
        return (s.get("kind") == "generate" and s.get("size") == size and s.get("state") in ("stopped", "failed")
                and s.get("phase") in PHASES[:-1] and not self.running())

    def _save(self, **changes: Any) -> None:
        self._state.update(changes, updated_at=_now())
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._state, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    def state(self) -> dict[str, Any]:
        """The most recent job: a file import's result when it came after the generation's last change. A stopped
        generation is still offered for resuming either way (`generation`)."""
        g = self._generation_state()
        if self._file and not self.running() and self._file.get("updated_at", "") > self._state.get("updated_at", ""):
            return {**{"phase": None, "size": None, "timings": {}}, **{k: v for k, v in self._file.items()
                                                                        if k != "updated_at"}, "generation": g}
        return {**g, "generation": g}

    def _generation_state(self) -> dict[str, Any]:
        s = self._state
        return {"state": s.get("state", "idle"), "done": s.get("done", 0), "total": s.get("total", 0),
                "message": s.get("message", ""), "phase": s.get("phase"), "size": s.get("size"),
                "kind": s.get("kind"), "rejected": s.get("rejected", []), "rejected_count": s.get("rejected_count", 0),
                "timings": s.get("timings", {})}

    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    # ----- the generator -----
    def generate(self, size: int) -> dict[str, Any]:
        if size not in D.SIZES:
            raise ApiError(400, "invalid_request", f"size is one of {', '.join(f'{s:,}' for s in D.SIZES)}.")
        with self._exclusive():
            release = self._job_lock()
            try:
                resume = self.resumable(size)
                if not resume:
                    dims = self.model_dims()
                    self.store().reset(dims)
                    self._state = {"kind": "generate", "size": size, "phase": "products", "cursor": 0, "dims": dims,
                                   "started_at": _now(), "timings": {}}
                self._stop.clear()
                self._save(state="running", message="Carrying on where it stopped." if resume else "Starting.",
                           rejected=[], rejected_count=0)
                self._thread = threading.Thread(target=self._run, args=(size, release), name="shop-import",
                                                daemon=True)
                self._thread.start()
            except BaseException:
                release()
                raise
            return self.state()

    @contextmanager
    def _exclusive(self) -> Iterator[None]:
        """This process's one job at a time. A second request is told at once, never left waiting while a large
        file imports (and then run over what it imported)."""
        if not self._lock.acquire(blocking=False):
            raise ApiError(409, "busy", "An import is already running. Wait for it, or stop it first.")
        try:
            if self.running():
                raise ApiError(409, "busy", "An import is already running. Wait for it, or stop it first.")
            yield
        finally:
            self._lock.release()

    def _job_lock(self) -> Callable[[], None]:
        """The store's cross-process import lock, or 409 when another process (the backend, or
        tools/shop-data.sh) is generating or importing into this shop."""
        release = self.store().try_job_lock()
        if release is None:
            raise ApiError(409, "busy", "Another process is generating or importing into this shop (the backend's "
                                        "Lab tab, or ./tools/shop-data.sh). Wait for it to finish.")
        return release

    def wait(self, timeout_s: float | None = None) -> bool:
        """Waits for the running generation to end (the command-line script). True when none is running."""
        thread = self._thread
        if thread is not None:
            thread.join(timeout_s)
        return not self.running()

    def model_dims(self) -> int:
        """The embedding model's vector length, so the table's halfvec column fits it; 768 when none answers."""
        if not (getattr(self.embedder, "model", "") or "").strip():
            return 768
        try:
            return len(self.embedder.embed(["dimension check"], "document")[0])
        except Exception:  # noqa: BLE001
            return 768

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        if self._thread:
            self._thread.join(15)
        return self.state()

    def _run(self, size: int, release: Callable[[], None] = lambda: None) -> None:
        try:
            self._generate(size)
        finally:
            release()

    def _generate(self, size: int) -> None:
        store, n = self.store(), size
        customers = D.customer_count(n)
        try:
            while self._state["phase"] != "done":
                if self._stop.is_set():
                    self._save(state="stopped", message=f"Stopped during {self._state['phase']}. Generate the same "
                                                        "size again to carry on.")
                    return
                phase = self._state["phase"]
                started = time.time()
                if phase == "products":
                    self._batches(n, self.product_batch, "products",
                                  lambda a, b: store.upsert_products([D.generate_product(i) for i in range(a, b)]))
                elif phase == "customers":
                    self._batches(customers, CUSTOMER_BATCH, "customers",
                                  lambda a, b: store.upsert_customers([D.generate_customer(j) for j in range(a, b)]))
                elif phase == "orders":
                    self._batches(customers, ORDER_CUSTOMERS, "customers' orders",
                                  lambda a, b: store.insert_orders([o for j in range(a, b)
                                                                    for o in D.generate_orders(j, n)]))
                elif phase == "embedding":
                    self._embed()
                elif phase == "index":
                    if store.counts()["embedded"]:
                        self._save(message="Building the vector index (HNSW) over every product…", done=0, total=1)
                        store.build_index()
                if self._stop.is_set():
                    continue  # a stopped batch loop leaves the phase as it was
                timings = dict(self._state.get("timings", {}))
                timings[phase] = round(time.time() - started + timings.get(phase, 0), 2)
                self._save(phase=PHASES[PHASES.index(phase) + 1], cursor=0, timings=timings)
            c = store.counts()
            self._save(state="done", done=c["products"], total=c["products"], finished_at=_now(),
                       message=f"Ready: {c['products']:,} products, {c['customers']:,} shoppers, {c['orders']:,} orders, "
                               f"{c['embedded']:,} embedded." + (f" {self.worker.message}" if self.worker.message
                                                                 else ""))
        except VectorDbUnavailable as exc:
            self._save(state="failed", message=str(exc))
        except Exception as exc:  # noqa: BLE001  (the page shows it; generating again carries on)
            log.exception("Shop: the import failed.")
            self._save(state="failed", message=f"{type(exc).__name__}: {exc}. Generate the same size again to carry on.")

    def _batches(self, total: int, step: int, what: str, write: Callable[[int, int], None]) -> None:
        cursor = int(self._state.get("cursor", 0))
        while cursor < total and not self._stop.is_set():
            end = min(total, cursor + step)
            write(cursor, end)
            cursor = end
            self._save(cursor=cursor, done=cursor, total=total, message=f"Loading {what}: {cursor:,} of {total:,}.")

    def _embed(self) -> None:
        if not self.worker.model():
            self.worker.process_once()  # sets the message that says why there are no vectors
            self._save(message=self.worker.message)
            return
        q = self.store().embedding_status()
        total = q["pending"] + q["done"] + q["failed_count"]

        def progress(_: int) -> None:
            s = self.store().embedding_status()
            self._save(done=s["done"], total=total, message=f"Embedding products: {s['done']:,} of {total:,} "
                                                            f"({self.worker.status()['rate_per_min']:,} a minute).")

        self._save(done=q["done"], total=total, message=f"Embedding products: {q['done']:,} of {total:,}.")
        while not self._stop.is_set():
            self.worker.drain(self._stop, progress)
            s = self.store().embedding_status()
            if s["pending"] == 0 or self.worker.paused():
                break
            time.sleep(0.5)  # retries waiting out their backoff, or another worker holding a batch

    def refresh(self, progress: Callable[[int, int], None] | None = None) -> int:
        """Rewrites the generated products from the generator as the code now stands (after a change to its wording,
        attributes or prices), keeping every shopper, order, basket and each product's current stock. The trigger
        marks only products whose embedded text changed, and the embedding worker re-embeds those. It overwrites
        edits made to generated products in the Lab tab. Returns how many products it rewrote."""
        size = self._state.get("size") if self._state.get("kind") == "generate" else None
        if self._state.get("state") != "done" or not size:
            raise ApiError(409, "not_generated", "There is no finished generated shop to refresh. Generate one first.")
        with self._exclusive():
            release = self._job_lock()
            try:
                store = self.store()
                for start in range(0, size, self.product_batch):
                    end = min(size, start + self.product_batch)
                    rows = [D.generate_product(i) for i in range(start, end)]
                    current = store.get_products_owner([r["id"] for r in rows])
                    for r in rows:
                        if r["id"] in current:
                            r["stock"] = current[r["id"]]["stock"]
                    store.upsert_products([r for r in rows if r["id"] in current])  # deleted ones stay deleted
                    if progress:
                        progress(end, size)
                store.bump_data_version()  # cached answers quoted the old wording
                return size
            finally:
                release()

    # ----- a person's own file -----
    def import_file(self, kind: str, name: str, raw: bytes) -> dict[str, Any]:
        if kind not in ("products", "customers", "orders"):
            raise ApiError(400, "invalid_request", "kind is products, customers or orders.")
        if not name.lower().endswith((".jsonl", ".ndjson", ".json", ".csv")):
            raise ApiError(400, "invalid_request", "Import a JSON Lines (.jsonl) or CSV (.csv) file.")
        if len(raw) > MAX_FILE_BYTES:
            raise ApiError(413, "too_large", f"The file is over {MAX_FILE_BYTES // 2**20} MB.")
        with self._exclusive():
            release = self._job_lock()  # held from the checks to the write, so a generation cannot come between
            try:
                return self._import_checked(kind, name, raw)
            finally:
                release()

    def _import_checked(self, kind: str, name: str, raw: bytes) -> dict[str, Any]:
        try:
            rows = self._checked(kind, name, raw)
        except UnicodeDecodeError:
            raise ApiError(400, "invalid_request", "The file must be UTF-8 text.") from None
        except D.Rejected as exc:
            message = (f"Nothing was imported: {exc.total:,} row{'s' if exc.total != 1 else ''} failed the checks. "
                       "Fix them and import the file again.")
            self._save_file({"kind": "file", "file_kind": kind, "state": "failed", "done": 0, "total": 0,
                             "rejected": exc.problems[:MAX_REJECTED_SHOWN], "rejected_count": exc.total,
                             "message": message})
            raise ApiError(400, "invalid_request", message + " " + "; ".join(exc.problems[:5]))
        self.store().apply_file(kind, rows)
        self._save_file({"kind": "file", "file_kind": kind, "state": "done", "done": len(rows),
                         "total": len(rows), "rejected": [], "rejected_count": 0, "finished_at": _now(),
                         "message": f"Imported {len(rows):,} {kind} from {name}."
                                    + (" New and changed products are being embedded in the background."
                                       if kind == "products" else "")})
        return self.state()

    def _checked(self, kind: str, name: str, raw: bytes) -> list[dict[str, Any]]:
        problems: list[str] = []
        parsed: list[tuple[int, dict[str, Any]]] = []
        for line, row in D.parse_rows(raw, name):
            if isinstance(row, str):
                problems.append(f"line {line}: {row}")
            else:
                parsed.append((line, row))
        if kind == "orders" and name.lower().endswith(".csv"):
            parsed = D.group_order_rows(parsed)
        clean = {"products": D.clean_product, "customers": D.clean_customer, "orders": D.clean_order}[kind]
        rows: list[dict[str, Any]] = []
        seen: set[str] = set()
        key = "customer_id" if kind == "customers" else "id"
        for line, row in parsed:
            try:
                c = clean(row)
            except ValueError as exc:
                problems.append(f"line {line}: {exc}")
                continue
            if c[key] in seen:
                problems.append(f"line {line}: {c[key]} appears more than once in the file")
                continue
            seen.add(c[key])
            rows.append(c)
        if not rows and not problems:
            problems.append("the file has no rows")
        if kind == "orders" and rows:
            store = self.store()
            known_c = store.existing_customers(sorted({o["customer_id"] for o in rows}))
            known_p = store.existing_products(sorted({it["product_id"] for o in rows for it in o["items"]}))
            for o in rows:
                if o["customer_id"] not in known_c:
                    problems.append(f"order {o['id']}: no shopper {o['customer_id']} (import customers first)")
                missing = sorted({it["product_id"] for it in o["items"]} - known_p)
                if missing:
                    problems.append(f"order {o['id']}: no product {', '.join(missing[:3])} (import products first)")
        if problems:
            raise D.Rejected(problems, len(problems))
        return rows
