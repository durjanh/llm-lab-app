#!/usr/bin/env bash
# Runs the sandbox image (examples/coding-sandbox) in Docker on this machine, for LLM_LAB_SANDBOX=docker: the coding
# agent's commands, and skills and decks with GPT or the local model, run here instead of in Azure. It is the same
# image and the same protocol as the Azure sandbox, so what works here works there.
#
#   ./tools/sandbox.sh             build the image if it is missing, start it on 127.0.0.1:8099, check it answers
#   ./tools/sandbox.sh --rebuild   build the image again first (after changing the Dockerfile or server.py)
#   ./tools/sandbox.sh --stop      stop it
#
# It listens on 127.0.0.1 only: anyone who can reach it can run commands in it. It restarts with Docker Desktop.
# The skills' scripts are not in the image (they travel with each command), so changing a skill needs no rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-coding-sandbox:local}"
NAME="llm-lab-sandbox"
PORT="${PORT:-8099}"

case "${1:-}" in
  --stop) docker rm -f "$NAME" >/dev/null 2>&1 && echo "Stopped $NAME."; exit 0 ;;
  --rebuild) REBUILD=1 ;;
  "") REBUILD= ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac

if [ -n "$REBUILD" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Building $IMAGE (the first build takes several minutes: LibreOffice and Chromium are large)..."
  docker build -t "$IMAGE" examples/coding-sandbox
  docker rm -f "$NAME" >/dev/null 2>&1 || true
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped -p "127.0.0.1:$PORT:8080" "$IMAGE" >/dev/null
fi

for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "The sandbox did not answer on 127.0.0.1:$PORT." >&2; exit 1; }
echo "The sandbox is running at http://127.0.0.1:$PORT."

grep -q "^LLM_LAB_SANDBOX=docker" .env 2>/dev/null \
  || echo "Set LLM_LAB_SANDBOX=docker in .env and restart the backend to use it (sessions uses the Azure one)."
