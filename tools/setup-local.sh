#!/usr/bin/env bash
# Sets up everything the lab runs in Docker on this machine, in order, by running each tool script: the database, the
# embedding model, the chat model, the sandbox, then the shop's data and the sample documents. For a new machine or
# a fresh clone, and safe to run again at any time (after a restart, or to check all is well): each step only does
# what is missing. It never edits .env; at the end it says which lines .env still needs.
#
#   ./tools/setup-local.sh                  everything
#   ./tools/setup-local.sh --no-chat-model  skip the local chat model (a 6.9 GB download; Claude still works)
#   ./tools/setup-local.sh --no-data        set up the services only: no shop data or sample documents
#
# Before it: Docker Desktop running, and the one-time setup in the main README (.venv, npm install, .env).
# The labs with their own Python environments are separate: ./tools/setup-envs.sh. Azure is separate: azd up.
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/lib.sh

CHAT=1
DATA=1
for arg in "$@"; do
  case "$arg" in
    --no-chat-model) CHAT=0 ;;
    --no-data) DATA=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Open Docker Desktop, wait until it says it is running, then run this again." >&2
  exit 1
fi
need_venv
[ -d frontend/node_modules ] || echo "Note: frontend/node_modules is missing; run npm install in frontend/ before the dev server."

failed=()
step() {  # step "what" command...: runs one script, keeps going if it fails, and remembers what failed
  local what="$1"
  shift
  printf '\n=== %s ===\n' "$what"
  if "$@"; then
    echo "OK: $what"
  else
    echo "FAILED: $what (see above; run it again on its own: $*)"
    failed+=("$what")
  fi
}

step "PostgreSQL with pgvector (127.0.0.1:5433)" ./tools/vector-db.sh
step "Local embedding model (search by meaning)" ./tools/local-model.sh --embed
step "Small \"cognitive core\" model for /cognitive-core (0.6 GB)" ./tools/local-model.sh --core
if [ "$CHAT" = 1 ]; then
  step "Local chat model (Docker Model Runner, localhost:12434)" ./tools/local-model.sh
fi
step "Sandbox for commands, skills and decks (127.0.0.1:8099)" ./tools/sandbox.sh
if [ "$DATA" = 1 ]; then
  step "Shop schema" .venv/bin/python tools/shop_data.py setup
  step "Shop data (20,000 products, only if the shop is empty)" .venv/bin/python tools/shop_data.py generate 20000 --if-empty
  step "Sample documents for /vector-db and /graphrag" .venv/bin/python tools/vector_samples.py load
fi

# What .env still needs for the pieces above. Only whether a line is there is checked; no value is read out.
missing=()
has() { grep -qE "^$1=." .env 2>/dev/null; }
[ -f .env ] || missing+=("the .env file itself: umask 077 && cp .env.example .env, then add ANTHROPIC_API_KEY")
has ANTHROPIC_API_KEY || missing+=("ANTHROPIC_API_KEY=<your key>  (Claude; the lab runs without it on the local model)")
has LLM_LAB_LOCAL_EMBED_MODEL || missing+=("LLM_LAB_LOCAL_EMBED_MODEL=ai/nomic-embed-text-v1.5")
if [ "$CHAT" = 1 ]; then has LLM_LAB_LOCAL_MODEL || missing+=("LLM_LAB_LOCAL_MODEL=ai/qwen3.5:9b-q4_K_XL"); fi
grep -qE "^LLM_LAB_SANDBOX=docker" .env 2>/dev/null || missing+=("LLM_LAB_SANDBOX=docker  (use the sandbox started above)")

printf '\n=== Summary ===\n'
if [ ${#failed[@]} -eq 0 ]; then echo "Every step worked."; else printf 'Failed: %s\n' "${failed[@]}"; fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "Add these to .env, then restart the backend:"
  printf '  %s\n' "${missing[@]}"
fi
echo "Next: start the backend and the frontend (README, Start: Run it)."
[ ${#failed[@]} -eq 0 ]
