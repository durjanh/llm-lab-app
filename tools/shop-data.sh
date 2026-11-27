#!/usr/bin/env bash
# Sets up and fills the Shopping Assistant's database (/shop-assistant), on a new machine or after a change, without
# the page. Every command is safe to run again. It uses the lab's .env and the same code as the backend.
#
#   ./tools/shop-data.sh                          start PostgreSQL and the embedding model, create or upgrade the schema
#   ./tools/shop-data.sh status                   what is in the shop: rows, embeddings, the vector index
#   ./tools/shop-data.sh generate 20000           an invented shop of 20000, 100000 or 1000000 products, with shoppers
#                                                 and orders; Ctrl+C stops it, the same command carries on
#   ./tools/shop-data.sh import products f.jsonl  your own products, customers or orders (JSON Lines or CSV); rows with
#                                                 the same id are replaced, and a file with any bad row is refused
#   ./tools/shop-data.sh embed [--retry]          embed new and changed products, or those made with another model
#   ./tools/shop-data.sh refresh                  after changing the generator: rewrite the generated products, keeping
#                                                 shoppers, orders and stock (it overwrites Lab tab edits to them)
#   ./tools/shop-data.sh reindex                  build or rebuild the vector index
#
# The backend keeps embeddings in step by itself while it runs; `embed` is for changes made while it was stopped.
set -euo pipefail
cd "$(dirname "$0")/.."
. tools/lib.sh

need_venv
PY=.venv/bin/python

case "${1:-setup}" in
  -h|--help) usage; exit 0 ;;
  setup)
    ./tools/vector-db.sh
    ./tools/local-model.sh --embed || echo "No embedding model, so products are found by their words only. Run ./tools/local-model.sh --embed later, then ./tools/shop-data.sh embed."
    exec "$PY" tools/shop_data.py setup ;;
  *) exec "$PY" tools/shop_data.py "$@" ;;
esac
