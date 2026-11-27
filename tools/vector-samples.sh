#!/usr/bin/env bash
# Loads the lab's sample documents into the vector database, on a new machine or after changing them, without the
# page: the /vector-db page's sample sets and the /graphrag sample corpus. Safe to run again: a document loaded twice
# replaces itself. It uses the lab's .env and the backend's own code, and makes no paid calls.
#
#   ./tools/vector-samples.sh                     start PostgreSQL and the embedding model, then load every set
#   ./tools/vector-samples.sh load handbook       load only the sets named (handbook, medassist, restricted, graphrag)
#   ./tools/vector-samples.sh list                the sets, and what is already in the database
#
# Building the GraphRAG graph from its sample calls a model, so that stays on the /graphrag page (Build).
set -euo pipefail
cd "$(dirname "$0")/.."
. tools/lib.sh

need_venv
PY=.venv/bin/python

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "")
    ./tools/vector-db.sh
    ./tools/local-model.sh --embed
    exec "$PY" tools/vector_samples.py load ;;
  *) exec "$PY" tools/vector_samples.py "$@" ;;
esac
