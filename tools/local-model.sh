#!/usr/bin/env bash
# Runs an open model on this machine with Docker Model Runner, for the lab's local default model (LLM_LAB_LOCAL_MODEL).
# Model Runner comes with Docker Desktop. On a Mac it runs llama.cpp on the host with Metal, so the model uses the GPU,
# which an ordinary container cannot reach; on Linux and Windows it uses an NVIDIA GPU when there is one, the CPU
# otherwise. It serves the Anthropic Messages API at http://localhost:12434/anthropic, which the lab calls with the
# Anthropic SDK, and the OpenAI API at http://localhost:12434/engines/v1.
#
#   ./tools/local-model.sh            enable Model Runner on port 12434, pull the model, set its context, check it answers
#   ./tools/local-model.sh --stop     unload the model from memory (it stays downloaded)
#   ./tools/local-model.sh --remove   delete the model's files (about 7 GB)
#   ./tools/local-model.sh --embed    pull an open embedding model too, for the embeddings page, and check it answers
#
# The model is LLM_LAB_LOCAL_MODEL from the environment or .env, or Qwen 3.5 9B. Another one from Docker Hub's ai/
# namespace works the same way: `docker model search <name>` lists them; choose one that can call tools.
# The embedding model is LLM_LAB_LOCAL_EMBED_MODEL, or nomic-embed-text v1.5 (about 270 MB, 768 numbers per text).
# ai/mxbai-embed-large, ai/embeddinggemma and ai/qwen3-embedding are other embedding models in the same namespace.
set -euo pipefail
cd "$(dirname "$0")/.."

MODEL="${LLM_LAB_LOCAL_MODEL:-$(sed -n 's/^LLM_LAB_LOCAL_MODEL=//p' .env 2>/dev/null | tail -1)}"
MODEL="${MODEL:-ai/qwen3.5:9b-q4_K_XL}"
EMBED_MODEL="${LLM_LAB_LOCAL_EMBED_MODEL:-$(sed -n 's/^LLM_LAB_LOCAL_EMBED_MODEL=//p' .env 2>/dev/null | tail -1)}"
EMBED_MODEL="${EMBED_MODEL:-ai/nomic-embed-text-v1.5}"
PORT="${PORT:-12434}"
CONTEXT="${CONTEXT:-32768}"  # agent pages send long prompts (instructions, tools, history); the server's default is smaller

case "${1:-}" in
  --stop) docker model unload "$MODEL"; exit 0 ;;
  --remove) docker model rm "$MODEL"; exit 0 ;;
  --embed|"") ;;
  *) sed -n '2,17p' "$0"; exit 1 ;;
esac

if ! docker model status >/dev/null 2>&1; then
  echo "Enabling Docker Model Runner on port $PORT..."
  docker desktop enable model-runner --tcp="$PORT" || {
    echo "Could not enable it. In Docker Desktop: Settings > AI > Enable Docker Model Runner, with host-side TCP" \
         "support on port $PORT. On Linux without Docker Desktop, install the docker-model-plugin package." >&2
    exit 1
  }
fi

if [ "${1:-}" = "--embed" ]; then
  docker model pull "$EMBED_MODEL"
  echo "Checking it embeds (the first request loads the model)..."
  curl -sf "http://localhost:$PORT/engines/v1/embeddings" -H 'content-type: application/json' \
    -d "{\"model\": \"$EMBED_MODEL\", \"input\": [\"ready\"]}" \
    | python3 -c 'import json, sys; print("Numbers per text:", len(json.load(sys.stdin)["data"][0]["embedding"]))' || {
    echo "No answer on http://localhost:$PORT. Check that host-side TCP support is on in Docker Desktop's AI settings." >&2
    exit 1
  }
  grep -q "^LLM_LAB_LOCAL_EMBED_MODEL=" .env 2>/dev/null \
    || echo "Add LLM_LAB_LOCAL_EMBED_MODEL=$EMBED_MODEL to .env and restart the backend. The embeddings page then offers it."
  exit 0
fi

docker model pull "$MODEL"
docker model configure --context-size "$CONTEXT" --keep-alive 30m "$MODEL"

echo "Checking it answers (the first request loads the model, so it takes a few seconds)..."
reply=$(curl -sf "http://localhost:$PORT/anthropic/v1/messages" -H 'content-type: application/json' \
  -d "{\"model\": \"$MODEL\", \"max_tokens\": 20, \"messages\": [{\"role\": \"user\", \"content\": \"Say ready.\"}],
       \"chat_template_kwargs\": {\"enable_thinking\": false}}") || {
  echo "No answer on http://localhost:$PORT. Check that host-side TCP support is on in Docker Desktop's AI settings." >&2
  exit 1
}
echo "$reply" | python3 -c 'import json, sys; print("Model says:", "".join(b.get("text", "") for b in json.load(sys.stdin)["content"]))'

grep -q "^LLM_LAB_LOCAL_MODEL=" .env 2>/dev/null || echo "Add LLM_LAB_LOCAL_MODEL=$MODEL to .env and restart the backend to make it the default."
