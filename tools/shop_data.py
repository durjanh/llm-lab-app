"""Sets up and fills the Shopping Assistant's database (/shop-assistant) without the web server.

Run it through ./tools/shop-data.sh, which starts PostgreSQL and the embedding model first. Every command is safe to
run again: `setup` creates the `shop` schema or brings it up to date, `generate` carries on from where a stopped run
left off, an imported file replaces the rows it names, and `embed` only embeds what is pending. It uses the same code,
settings (.env) and state file (generated/shop/import.json) as the backend, and the same database lock, so it waits
its turn rather than writing over an import running on the page.
"""
from __future__ import annotations

import argparse
import signal
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.app.core.errors import ApiError  # noqa: E402
from backend.app.gateways.local_embeddings import LocalEmbeddings  # noqa: E402
from backend.app.gateways.pgvector import VectorDbUnavailable  # noqa: E402
from backend.app.services import shop_data as D  # noqa: E402
from backend.app.services.shop_embedding import EmbedWorker  # noqa: E402
from backend.app.services.shop_import import ShopImporter  # noqa: E402
from backend.app.services.shop_schema import SCHEMA_VERSION  # noqa: E402
from backend.app.services.shop_store import PgShopStore  # noqa: E402
from backend.app.settings import Settings  # noqa: E402


class Shop:
    """The parts of ShopService that hold data, built from the lab's settings: the store, the embedding worker and
    the importer, writing the same state file the backend reads."""

    def __init__(self, settings: Settings, store: Any = None, embedder: Any = None):
        self.settings = settings
        self.store = store if store is not None else PgShopStore(settings.pgvector_url)
        self.embedder = embedder if embedder is not None else LocalEmbeddings(settings.local_embed_model,
                                                                               settings.local_openai_url)
        self.worker = EmbedWorker(lambda: self.store, self.embedder)
        self.importer = ShopImporter(lambda: self.store, self.worker, state_path(settings), self.embedder)


def state_path(settings: Settings) -> Path:
    """The importer's state file, the one ShopService keeps in generated/shop/."""
    return settings.generated_dir / "shop" / "import.json"


def backend_running(port: int) -> bool:
    """True when something answers on the backend's port on this machine."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


# ----- commands -----
def status(shop: Shop) -> int:
    s = shop.store.status()
    print(f"Database: {s['where'] or 'not set'} ({'answering' if s['available'] else s['message']})")
    if not s["available"]:
        return 1
    shop.store.ensure(shop.importer.model_dims())  # a new schema is sized for the model, as setup makes it
    c = shop.store.counts()
    q = shop.store.embedding_status()
    print(f"Schema: shop, version {shop.store.get_meta('schema_version') or '?'} (this code: {SCHEMA_VERSION}), "
          f"{shop.store.dims_()} numbers per vector")
    print(f"Rows: {c['products']:,} products, {c['customers']:,} shoppers, {c['orders']:,} orders")
    print(f"Embeddings: {q['done']:,} done, {q['pending']:,} pending, {q['failed_count']:,} failed; "
          f"vector index {'built' if shop.store.has_index() else 'not built'}")
    print(f"Embedding model: {shop.worker.model() or 'none (set LLM_LAB_LOCAL_EMBED_MODEL)'}")
    job = shop.importer.state()
    if job.get("message"):
        print(f"Last import: {job['state']}. {job['message']}")
    return 0


def setup(shop: Shop) -> int:
    """Creates the schema, or brings one made by older code up to date, sized for the configured embedding model."""
    shop.store.ensure(shop.importer.model_dims())
    print("The shop schema is ready.")
    return status(shop)


def generate(shop: Shop, size: int) -> int:
    resuming = shop.importer.resumable(size)
    shop.importer.generate(size)
    print(f"{'Carrying on with' if resuming else 'Generating'} a shop of {size:,} products. Ctrl+C stops it; "
          "run the same command again to carry on.")
    return _follow(shop)


def _follow(shop: Shop) -> int:
    """Prints the generation's progress until it ends. Ctrl+C stops it cleanly, so it can carry on later."""
    stopping = threading.Event()

    def interrupt(*_: Any) -> None:
        stopping.set()

    previous = signal.signal(signal.SIGINT, interrupt)
    last = ""
    try:
        while not shop.importer.wait(1.0):
            if stopping.is_set():
                print("\nStopping after the current batch...")
                shop.importer.stop()
                break
            message = shop.importer.state()["message"]
            if message != last:
                print(message)
                last = message
    finally:
        signal.signal(signal.SIGINT, previous)
        shop.importer.wait()
    state = shop.importer.state()
    print(state["message"])
    return 0 if state["state"] == "done" else 1


def import_file(shop: Shop, kind: str, path: Path) -> int:
    state = shop.importer.import_file(kind, path.name, path.read_bytes())
    print(state["message"])
    if kind == "products":
        return embed(shop, retry=False)
    return 0


def embed(shop: Shop, retry: bool) -> int:
    """Embeds every pending product: new or changed ones, and those made with another model. With retry, the failed
    ones too. The backend's worker does the same in the background; this is for when it is not running."""
    if not shop.worker.model():
        print("No embedding model is set: run ./tools/local-model.sh --embed and set LLM_LAB_LOCAL_EMBED_MODEL in "
              ".env. Products are still found by their words.")
        return 1
    if retry:
        print(f"Put {shop.store.retry_failed(None):,} failed product(s) back in the queue.")
    while shop.worker.check_model():  # products embedded with another model go back in the queue
        pass
    total = shop.store.embedding_status()["pending"]
    print(f"Embedding {total:,} pending product(s) with {shop.worker.model()}...")
    started, shown = time.time(), 0.0
    stop = threading.Event()

    def progress(done: int) -> None:
        nonlocal shown
        if time.time() - shown > 5:
            shown = time.time()
            rate = done / max(shown - started, 0.001)
            print(f"  {done:,} of {total:,} ({rate:,.0f} a second)")

    try:
        while True:
            shop.worker.drain(stop, progress)
            q = shop.store.embedding_status()
            if q["pending"] == 0:
                break
            if shop.worker.paused():
                print(shop.worker.message)
                return 1
            time.sleep(0.5)  # retries waiting out their backoff
    except KeyboardInterrupt:
        print("\nStopped. What is done is kept; run it again to carry on.")
        return 1
    q = shop.store.embedding_status()
    print(f"Done: {q['done']:,} embedded, {q['failed_count']:,} failed." +
          (" Run `embed --retry` to try the failed ones again." if q["failed_count"] else ""))
    if q["done"] and not shop.store.has_index():
        reindex(shop)
    else:
        shop.worker.maybe_reindex(wait=True)
    return 0 if not q["failed_count"] else 1


def refresh(shop: Shop) -> int:
    """After a change to the generator: rewrite the generated products, keep shoppers, orders and stock, then embed
    what changed (the backend's worker does it too, if it is running)."""
    def progress(done: int, total: int) -> None:
        if done == total or done % 20_000 == 0:
            print(f"  {done:,} of {total:,} products rewritten")

    shop.importer.refresh(progress)
    print("Rewritten. Products whose text changed are now pending.")
    return embed(shop, retry=False)


def reindex(shop: Shop) -> int:
    """Builds the HNSW index, or rebuilds it without blocking searches when it exists."""
    started = time.time()
    if shop.store.has_index():
        if not shop.store.reindex():
            print("Another process (the backend's embedding worker) is rebuilding the index now. Try again later.")
            return 1
    else:
        shop.store.build_index()
    print(f"Vector index ready in {time.time() - started:.1f} s.")
    return 0


def main(argv: list[str] | None = None, shop: Shop | None = None) -> int:
    """Runs one command. `shop` is for tests, which pass one built on the memory store."""
    parser = argparse.ArgumentParser(prog="tools/shop-data.sh", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("setup", help="create or upgrade the shop schema, then show the status (the default)")
    sub.add_parser("status", help="what is in the shop")
    g = sub.add_parser("generate", help="generate an invented shop, or carry on with a stopped one")
    g.add_argument("size", type=int, choices=D.SIZES, help="how many products")
    g.add_argument("--force", action="store_true", help="go ahead while the backend is running")
    g.add_argument("--if-empty", action="store_true",
                   help="only when the shop has no products yet (tools/setup-local.sh), so running it again is safe")
    i = sub.add_parser("import", help="import a JSON Lines or CSV file (rows with the same id are replaced)")
    i.add_argument("kind", choices=("products", "customers", "orders"))
    i.add_argument("file", type=Path)
    e = sub.add_parser("embed", help="embed every pending product (after changing products outside the page)")
    e.add_argument("--retry", action="store_true", help="try the failed ones again too")
    sub.add_parser("refresh", help="after changing the generator: rewrite the generated products, keeping "
                                   "shoppers, orders and stock, and re-embed what changed")
    sub.add_parser("reindex", help="build or rebuild the vector index")
    args = parser.parse_args(argv)

    shop = shop or Shop(Settings.from_env())
    settings = shop.settings
    try:
        if args.command == "generate" and args.if_empty:
            shop.store.ensure(shop.importer.model_dims())
            products = shop.store.counts()["products"]
            if products and not shop.importer.resumable(args.size):
                print(f"The shop already has {products:,} products; leaving it as it is.")
                return 0
            args.force = True  # nothing to replace, or a stopped run of its own to carry on
        if args.command == "generate" and not args.force and backend_running(settings.port):
            print(f"The backend is running on port {settings.port}. A new shop replaces every shopper, basket and "
                  "order the page is using. Use the page's Lab tab, stop the backend, or add --force.")
            return 1
        if args.command == "generate":
            return generate(shop, args.size)
        if args.command == "import":
            return import_file(shop, args.kind, args.file)
        if args.command == "embed":
            return embed(shop, args.retry)
        if args.command == "refresh":
            return refresh(shop)
        if args.command == "reindex":
            return reindex(shop)
        if args.command == "status":
            return status(shop)
        return setup(shop)
    except (ApiError, VectorDbUnavailable) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"{exc.strerror}: {exc.filename}" if exc.filename else str(exc), file=sys.stderr)
        return 1
    finally:
        close = getattr(shop.store, "close", None)
        if close:
            close()


if __name__ == "__main__":
    sys.exit(main())
