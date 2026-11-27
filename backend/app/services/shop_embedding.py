"""Keeps the shop's product vectors in step with the products, so the index never needs a manual rebuild.

A trigger in the database marks a product `pending` when the text it is embedded from changes (never for price or stock
alone) and sends a notification. This worker, one per backend process, waits on that notification and also polls every
few seconds in case one was missed; it claims pending products with FOR UPDATE SKIP LOCKED, so two workers never embed
the same one, embeds them in batches with the local embedding model, and writes the vectors back. A batch that fails
is retried with exponential backoff, a retried product on its own; after five attempts the product is `failed`, listed
for a manual retry. When the configured model changes, products embedded with the old one are re-embedded in the
background while searches keep using their old vectors. After heavy churn (more than a fifth of the rows given new
vectors or deleted since the last build) the HNSW index is rebuilt with REINDEX CONCURRENTLY, which blocks nobody.
"""
from __future__ import annotations

import logging
import threading
import time
import urllib.error
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable

from ..gateways.local_embeddings import LocalEmbeddingsUnavailable
from ..gateways.pgvector import VectorDbUnavailable

log = logging.getLogger("backend.shop")
BATCH = 64
POLL_S = 3.0
MAX_ATTEMPTS = 5
BACKOFF_S = 2.0  # 2, 4, 8, 16 seconds between attempts
CHURN_SHARE = 0.2
MODEL_CHECK_S = 60.0
OUTAGE_WAIT_S = 30.0
MARK_BATCH = 5000  # products put back in the queue per check after a model change


def outage(exc: BaseException) -> bool:
    """True when the embedding server itself did not answer (nothing to do with the product): no attempt is counted,
    the worker waits instead. A refusal of the request (HTTP 4xx/5xx) counts against the products in it."""
    cause = exc.__cause__
    if isinstance(cause, urllib.error.HTTPError):
        return False
    return isinstance(exc, LocalEmbeddingsUnavailable) and isinstance(cause, (urllib.error.URLError, TimeoutError,
                                                                              OSError))


class EmbedWorker:
    def __init__(self, store: Callable[[], Any], embedder: Any, batch: int = BATCH, poll_s: float = POLL_S,
                 max_attempts: int = MAX_ATTEMPTS, backoff_s: float = BACKOFF_S, churn_share: float = CHURN_SHARE):
        self.store, self.embedder = store, embedder  # store() is the service's current store (tests swap it)
        self.batch, self.poll_s, self.max_attempts, self.backoff_s = batch, poll_s, max_attempts, backoff_s
        self.churn_share = churn_share
        self.message = ""
        self.last_batch_at: str | None = None
        self._recent: deque[tuple[float, int]] = deque()  # (when, products embedded) for the rate
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._reindexing = threading.Lock()
        self._model_checked = 0.0
        self._more_to_mark = False
        self._paused_until = 0.0
        self._batches = 0
        self._db_down: str | None = None  # the loop's message while the database did not answer

    # ----- one batch -----
    def model(self) -> str:
        return (getattr(self.embedder, "model", "") or "").strip()

    def process_once(self) -> int:
        """Claims and embeds one batch. Returns how many products it handled (0: nothing was ready)."""
        model = self.model()
        if not model:
            self.message = ("No local embedding model is set up, so new and changed products are found by their words "
                            "only. Run ./tools/local-model.sh --embed and set LLM_LAB_LOCAL_EMBED_MODEL.")
            return 0
        if time.time() < self._paused_until:
            return 0
        store = self.store()
        dims = store.dims_()
        with store.claim(self.batch) as c:
            if not c.rows:
                return 0
            c.model, c.max_attempts, c.backoff_s = model, self.max_attempts, self.backoff_s
            try:
                vectors = self.embedder.embed([text for _, text, _ in c.rows], "document")
                bad = next((len(v) for v in vectors if len(v) != dims), None)
                if bad is not None:
                    raise ValueError(f"{model} makes vectors of {bad} numbers but the shop's table holds {dims}; "
                                     "generate the shop again to use this model")
                c.done = [(pid, v) for (pid, _, _), v in zip(c.rows, vectors)]
                self.message = ""
            except Exception as exc:  # noqa: BLE001  (anything the embedder raises is recorded against the batch)
                if outage(exc):
                    # Leave the claim unwritten (the rows stay pending, no attempt counted) and wait for the server.
                    self.message = str(exc)
                    self._paused_until = time.time() + OUTAGE_WAIT_S
                    c.done, c.failed = [], []
                    return 0
                self.message = f"An embedding batch failed: {exc}"
                c.failed = [(pid, f"{type(exc).__name__}: {exc}") for pid, _, _ in c.rows]
        handled = len(c.rows)
        if c.done:
            now = time.time()
            self.last_batch_at = datetime.now(timezone.utc).isoformat()
            self._recent.append((now, len(c.done)))
            log.info("Shop: embedded %d product(s) with %s.", len(c.done), model)
        self._batches += 1
        if self._batches % 20 == 0 or c.replaced:
            self.maybe_reindex()
        return handled

    def drain(self, stop: threading.Event | None = None, progress: Callable[[int], None] | None = None) -> int:
        """Embeds until nothing is ready (the import's embedding phase). Returns the products handled."""
        total = 0
        while not (stop and stop.is_set()):
            n = self.process_once()
            if not n:
                break
            total += n
            if progress:
                progress(total)
        return total

    def maybe_reindex(self, wait: bool = False) -> bool:
        """Rebuilds the HNSW index in the background once churn passes the share. True when it started one."""
        store = self.store()
        try:
            churn = store.churn()  # one row of meta: most batches stop here
            if not churn or churn <= self.churn_share * max(store.approx_products(), 1) or not store.has_index():
                return False
        except VectorDbUnavailable:
            return False
        if not self._reindexing.acquire(blocking=False):
            return False

        def run() -> None:
            try:
                started = time.time()
                if store.reindex():
                    log.info("Shop: rebuilt the vector index after churn, in %.1f s.", time.time() - started)
                else:
                    log.info("Shop: another process is rebuilding the vector index; leaving it to that one.")
            except Exception:  # noqa: BLE001
                log.exception("Shop: the vector index could not be rebuilt.")
            finally:
                self._reindexing.release()

        if wait:
            run()
        else:
            threading.Thread(target=run, name="shop-reindex", daemon=True).start()
        return True

    def check_model(self) -> int:
        """Puts products embedded with another model back in the queue, a few thousand at a time."""
        model = self.model()
        if not model:
            return 0
        n = self.store().mark_model(model, MARK_BATCH)
        if n:
            log.info("Shop: %d product(s) were embedded with another model; re-embedding them with %s.", n, model)
        return n

    # ----- the background thread -----
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="shop-embed", daemon=True)
        self._thread.start()

    def stop(self, timeout_s: float = 10.0) -> bool:
        """Asks the thread to stop and waits for it. True when it has stopped."""
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout_s)
        stopped = not (thread and thread.is_alive())
        if stopped:  # its connections go with it; a thread still running keeps them until it ends
            try:
                self.store().close()
            except Exception:  # noqa: BLE001  (shutting down: say so, but do not stop the rest stopping)
                log.warning("Shop: the store's connections could not be closed.", exc_info=True)
        return stopped

    def paused(self) -> bool:
        """True while the embedding server is down and the worker is waiting before it tries again."""
        return time.time() < self._paused_until

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                if self._more_to_mark or time.time() - self._model_checked > MODEL_CHECK_S:
                    self._model_checked = time.time()
                    self._more_to_mark = self.check_model() >= MARK_BATCH  # a full batch: mark the next one soon
                if self.process_once():
                    continue
                # Nothing ready: wait for the trigger's notification, or the poll interval if none comes.
                self.store().wait_for_change(self.poll_s)
            except VectorDbUnavailable as exc:
                self.message = self._db_down = str(exc)
                self._stop.wait(self.poll_s * 5)
            except Exception:  # noqa: BLE001  (the worker must outlive any one bad batch)
                log.exception("Shop: the embedding worker hit an error; it carries on.")
                self._stop.wait(self.poll_s)

    def rate_per_min(self) -> int:
        """Products embedded in the last minute."""
        now = time.time()
        while self._recent and now - self._recent[0][0] > 60:
            self._recent.popleft()
        return sum(n for _, n in self._recent)

    def status(self) -> dict[str, Any]:
        rate = self.rate_per_min()
        message = self.message
        try:
            queue = self.store().embedding_status()
        except VectorDbUnavailable as exc:  # said for this answer only: nothing would clear it once the database is back
            queue = {"pending": 0, "done": 0, "failed": [], "failed_count": 0}
            message = str(exc)
        else:
            if self._db_down is not None and self.message == self._db_down:
                message = self.message = ""  # the loop's own "did not answer", from before the database came back
            self._db_down = None
        return {**queue, "last_batch_at": self.last_batch_at, "rate_per_min": rate,
                "model": self.model(), "running": self.running, "message": message,
                "reindexing": self._reindexing.locked()}
