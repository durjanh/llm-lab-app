#!/usr/bin/env bash
# Builds the frontend and deploys it to the lab's Azure Static Web App (Free plan). Only the pages go there: the
# backend is not hosted, so anything that calls a model, a database or Azure needs the lab running locally.
#
#   ./tools/deploy-frontend.sh              build frontend/dist and deploy it to production
#   ./tools/deploy-frontend.sh --no-build   deploy the frontend/dist that is already built
#
# It signs in with your Azure CLI login (az login) and fetches the site's deployment token for this one run; the
# token is never printed or saved. Set SWA_NAME, SWA_GROUP or SWA_SUBSCRIPTION to deploy somewhere else; without
# SWA_SUBSCRIPTION it uses the subscription az is set to. Routing (every page path serves index.html, /api/* does
# not) comes from frontend/public/staticwebapp.config.json.
set -euo pipefail
cd "$(dirname "$0")/.."
. tools/lib.sh

NAME="${SWA_NAME:-swa-llm-lab}"
GROUP="${SWA_GROUP:-rg-llm-lab}"
SUB_ARGS=()
[ -n "${SWA_SUBSCRIPTION:-}" ] && SUB_ARGS=(--subscription "$SWA_SUBSCRIPTION")

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --no-build) ;;
  "") (cd frontend && npm run build) ;;
  *) usage; exit 1 ;;
esac
[ -f frontend/dist/index.html ] || { echo "No frontend/dist yet: run it without --no-build." >&2; exit 1; }

echo "Deploying frontend/dist ($(du -sh frontend/dist | cut -f1)) to $NAME in $GROUP ($(az account show ${SUB_ARGS[@]+"${SUB_ARGS[@]}"} --query name -o tsv))..."
token=$(az staticwebapp secrets list -n "$NAME" -g "$GROUP" ${SUB_ARGS[@]+"${SUB_ARGS[@]}"} --query properties.apiKey -o tsv) || {
  echo "Could not read the site's deployment token. Run az login, and check the subscription (SWA_SUBSCRIPTION)." >&2
  exit 1
}
SWA_CLI_DEPLOYMENT_TOKEN="$token" npx --yes @azure/static-web-apps-cli@2.0.2 deploy ./frontend/dist \
  --env production --no-use-keychain 2>&1 | grep -iv token
host=$(az staticwebapp show -n "$NAME" -g "$GROUP" ${SUB_ARGS[@]+"${SUB_ARGS[@]}"} --query defaultHostname -o tsv)
echo "Live: https://$host"
