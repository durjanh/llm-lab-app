#!/usr/bin/env bash
# Runs PostgreSQL with the pgvector extension in Docker on this machine, for the vector database page (/vector-db).
# It listens on 127.0.0.1 only, so nothing else on the network can reach it, and keeps its data in a Docker volume,
# so documents survive a restart. The same SQL runs on Azure Database for PostgreSQL, which offers pgvector too.
#
#   ./tools/vector-db.sh            start it (pulls the image the first time), then check pgvector loads
#   ./tools/vector-db.sh --stop     stop it (the data stays in the volume)
#   ./tools/vector-db.sh --remove   stop it and delete its data
#   ./tools/vector-db.sh --psql     open psql inside it, to look at the tables yourself
#
# The page connects with LLM_LAB_PGVECTOR_URL, whose default matches what this script starts. The password is a fixed
# local one: the server is only reachable from this machine and holds only what you put in it on the page.
set -euo pipefail

NAME=llm-lab-pgvector
IMAGE=pgvector/pgvector:pg17
VOLUME=llm-lab-pgvector-data
PORT="${PORT:-5433}"  # not 5432, so it does not clash with a PostgreSQL already installed on this machine

case "${1:-}" in
  --stop) docker stop "$NAME" >/dev/null && echo "Stopped. The data is kept in the $VOLUME volume."; exit 0 ;;
  --remove) docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOLUME" >/dev/null 2>&1 || true
            echo "Removed the container and its data."; exit 0 ;;
  --psql) exec docker exec -it "$NAME" psql -U lab -d vectors ;;
  "") ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac

if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "Already running on 127.0.0.1:$PORT."
elif docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "Starting the existing container..."
  docker start "$NAME" >/dev/null
else
  echo "Starting PostgreSQL with pgvector on 127.0.0.1:$PORT..."
  # 1 GB of shared memory: parallel index builds share their work through it, and Docker's default is 64 MB.
  docker run -d --name "$NAME" --restart unless-stopped --shm-size=1g -p "127.0.0.1:$PORT:5432" \
    -e POSTGRES_USER=lab -e POSTGRES_PASSWORD=lab -e POSTGRES_DB=vectors \
    -v "$VOLUME:/var/lib/postgresql/data" "$IMAGE" >/dev/null
fi

echo "Waiting for it to accept connections..."
for _ in $(seq 1 30); do
  docker exec "$NAME" pg_isready -U lab -d vectors >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" psql -U lab -d vectors -tAc "CREATE EXTENSION IF NOT EXISTS vector; SELECT 'pgvector ' || extversion FROM pg_extension WHERE extname = 'vector'"
shm=$(docker inspect -f '{{.HostConfig.ShmSize}}' "$NAME")
if [ "$shm" -lt 1073741824 ]; then
  echo "Note: this container has $((shm / 1048576)) MB of shared memory, made before the script asked for 1 GB, so large" \
       "vector indexes build without parallel workers (slower). To fix it, keeping the data:" \
       "docker rm -f $NAME && ./tools/vector-db.sh"
fi
echo "Ready. Open /vector-db in the lab."
