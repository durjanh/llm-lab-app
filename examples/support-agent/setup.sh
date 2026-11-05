#!/usr/bin/env bash
# What the support agent needs in Azure, for the lab's hand-made resources (azd's infra/ makes the same):
#   1. a project connection to Azure AI Search, signed in with Entra (no search key), so the agent's
#      Azure AI Search tool can reach the index;
#   2. roles for the project's managed identity on the search service: the tool queries as the project;
#   3. the order-status API in Azure Container Apps: Foundry calls OpenAPI tools from the cloud, so the API
#      must be reachable from there, not only from this machine.
#
#   examples/support-agent/setup.sh            # uses the lab's .env
#   examples/support-agent/setup.sh --delete
set -euo pipefail
cd "$(dirname "$0")/../.."

env_value() { grep "^$1=" .env | head -1 | cut -d= -f2-; }
AI_ID=$(env_value AZURE_AI_RESOURCE_ID)
SEARCH_ENDPOINT=$(env_value AZURE_SEARCH_ENDPOINT)
PROJECT=$(env_value FOUNDRY_PROJECT_ENDPOINT | sed 's|.*/projects/||')
[[ -n "$AI_ID" && -n "$SEARCH_ENDPOINT" && -n "$PROJECT" ]] || {
  echo "Set AZURE_AI_RESOURCE_ID, AZURE_SEARCH_ENDPOINT and FOUNDRY_PROJECT_ENDPOINT in .env first." >&2; exit 1; }
RG=$(echo "$AI_ID" | sed 's|.*/resourceGroups/\([^/]*\)/.*|\1|')
SEARCH_NAME=$(echo "$SEARCH_ENDPOINT" | sed 's|https://\([^.]*\)\..*|\1|')
SEARCH_ID=$(az resource list --resource-type Microsoft.Search/searchServices --name "$SEARCH_NAME" --query "[0].id" -o tsv)
CONNECTION="$AI_ID/projects/$PROJECT/connections/support-search"
APP=order-status-api
ENVIRONMENT=${CONTAINERAPP_ENV:-$(az containerapp env list -g "$RG" --query "[0].name" -o tsv 2>/dev/null)}
MI=$(az rest --method get --url "https://management.azure.com$AI_ID/projects/$PROJECT?api-version=2025-06-01" --query identity.principalId -o tsv)
SEARCH_READER=1407120a-92aa-4202-b7e9-c0e197c71c8f        # Search Index Data Reader: run queries
SEARCH_SERVICE=7ca78c08-252a-4471-8644-bb5ff32d4ba0       # Search Service Contributor: read the index definition

if [[ "${1:-}" == "--delete" ]]; then
  az rest --method delete --url "https://management.azure.com$CONNECTION?api-version=2025-06-01" -o none && echo "Deleted the support-search connection"
  for role in "$SEARCH_READER" "$SEARCH_SERVICE"; do
    az role assignment delete --assignee "$MI" --role "$role" --scope "$SEARCH_ID" 2>/dev/null || true
  done
  echo "Removed the project's search roles"
  az containerapp delete -n "$APP" -g "$RG" --yes -o none 2>/dev/null && echo "Deleted $APP"
  exit 0
fi

echo "1. Project connection to $SEARCH_NAME (Entra sign-in)"
az rest --method put --url "https://management.azure.com$CONNECTION?api-version=2025-06-01" -o none --body "{
  \"properties\": {\"category\": \"CognitiveSearch\", \"target\": \"$SEARCH_ENDPOINT\", \"authType\": \"AAD\",
    \"isSharedToAll\": true, \"metadata\": {\"ApiType\": \"Azure\", \"ResourceId\": \"$SEARCH_ID\"}}}"

echo "2. Roles for the project's managed identity ($MI) on $SEARCH_NAME"
for role in "$SEARCH_READER" "$SEARCH_SERVICE"; do
  if [[ -z "$(az role assignment list --assignee "$MI" --role "$role" --scope "$SEARCH_ID" --query "[0].id" -o tsv)" ]]; then
    az role assignment create --assignee-object-id "$MI" --assignee-principal-type ServicePrincipal \
      --role "$role" --scope "$SEARCH_ID" -o none
  fi
done

echo "3. The order-status API in $ENVIRONMENT"
# No image to build: a plain python image runs the script, passed in base64 so no quoting can break it.
SCRIPT=$(base64 < examples/support-agent/order_api.py | tr -d '\n')
az containerapp create -n "$APP" -g "$RG" --environment "$ENVIRONMENT" --workload-profile-name Consumption \
  --image docker.io/library/python:3.12-slim --cpu 0.25 --memory 0.5Gi --min-replicas 0 --max-replicas 1 \
  --ingress external --target-port 8080 --command sh \
  --args "-c" "echo $SCRIPT | base64 -d > /tmp/order_api.py && HOST=0.0.0.0 PORT=8080 exec python /tmp/order_api.py" -o none
URL="https://$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)"
echo "   $URL/openapi.json"
echo
echo "Done. Add this line to .env, then: python examples/support-agent/support_agent.py create"
echo "ORDER_API_URL=$URL"
