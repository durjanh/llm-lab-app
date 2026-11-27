"""Loads the lab's sample documents into the vector database without the web server: the sets the /vector-db page's
sample buttons load (handbook, medassist, restricted) and the /graphrag sample corpus.

Run it through ./tools/vector-samples.sh, which starts PostgreSQL and the embedding model first. It is safe to run
again: adding a document replaces the one with the same name in its collection, so a set loaded twice is there once.
It calls the backend's own services with the lab's .env, and makes no model calls (embedding is local and free).
Building the GraphRAG graph from the sample does call a model, so that stays on the /graphrag page.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.app import cli  # noqa: E402
from backend.app.gateways.pgvector import PgVector  # noqa: E402
from backend.app.services.graphrag import load_sample as load_graphrag_sample  # noqa: E402
from backend.app.services.vectordb import VectorDbService, samples  # noqa: E402
from backend.app.settings import Settings  # noqa: E402

GRAPHRAG = "graphrag"
SETS = (*samples(), GRAPHRAG)


def service(settings: Settings) -> VectorDbService:
    """The vector database page's service, without a model client: loading and listing never call one."""
    embedder = cli.local_embedder(settings)
    return VectorDbService(PgVector(settings.pgvector_url), embedder, None, None)  # type: ignore[arg-type]


def load(svc: VectorDbService, key: str) -> dict[str, Any]:
    if key == GRAPHRAG:
        return load_graphrag_sample(svc)
    return svc.add_samples(key)


def main(argv: list[str] | None = None, svc: VectorDbService | None = None) -> int:
    """Runs one command. `svc` is for tests, which pass one built on fakes."""
    parser = argparse.ArgumentParser(prog="tools/vector-samples.sh", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command")
    lo = sub.add_parser("load", help="load sample sets (all of them when none is named)")
    lo.add_argument("sets", nargs="*", metavar="set", help=f"any of: {', '.join(SETS)}")
    sub.add_parser("list", help="the sample sets, and the documents already in the database")
    args = parser.parse_args(argv)
    unknown = [k for k in getattr(args, "sets", None) or [] if k not in SETS]
    if unknown:
        parser.error(f"no sample set {', '.join(unknown)}; choose from {', '.join(SETS)}")

    def command() -> int:
        s = svc or service(Settings.from_env())
        if not (s.embedder.model or "").strip():
            print("No embedding model is set: run ./tools/local-model.sh --embed and set LLM_LAB_LOCAL_EMBED_MODEL in "
                  ".env.", file=sys.stderr)
            return 1
        if args.command == "list":
            for key in SETS:
                title = "GraphRAG sample corpus (/graphrag)" if key == GRAPHRAG else samples()[key]["title"]
                print(f"{key:<11} {title}")
            rows = s.status().get("sources") or []
            print(f"\nIn the database ({s.embedder.model}): "
                  + (", ".join(f"{r['collection']}/{r['source']}" for r in rows) or "nothing yet"))
            return 0
        for key in args.sets or SETS:
            r = load(s, key)
            print(f"{key}: {r['documents']} document(s), {r['chunks']} chunk(s) in collection {r['collection']}")
        if GRAPHRAG in (args.sets or SETS):
            print("To build the GraphRAG graph from it, open /graphrag and press Build (that step calls a model).")
        return 0

    return cli.run(command)


if __name__ == "__main__":
    sys.exit(main())
