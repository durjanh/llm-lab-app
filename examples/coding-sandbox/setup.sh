#!/usr/bin/env bash
# Creates the coding agent's cloud sandbox: the image in Azure Container Registry, and a custom container session
# pool that runs it, one Hyper-V isolated container per agent session. Keyless throughout: the pool pulls the image
# with a managed identity, and whoever runs commands needs the Session Executor role on the pool.
#
# This creates billable resources in the subscription `az account show` names. Check it first. A custom container
# pool runs on dedicated E16 machines (16 vCPU, 128 GB), about £1.69 an hour in UK South while one is up. With no
# ready sessions (below) a machine runs only while an agent is working, and the first command waits for it to start.
#
#   RESOURCE_GROUP=rg-llm-lab ENVIRONMENT=cae-llm-lab REGISTRY=acrllmlab ./setup.sh
#   BACKEND_PRINCIPAL_ID=<the backend container app's managed identity> ...   # also lets the deployed backend call it
set -euo pipefail

: "${RESOURCE_GROUP:?Set RESOURCE_GROUP}"
: "${ENVIRONMENT:?Set ENVIRONMENT: an existing Container Apps environment (az containerapp env create)}"
: "${REGISTRY:?Set REGISTRY: an existing Azure Container Registry name}"
LOCATION="${LOCATION:-uksouth}"
POOL="${POOL:-coding-sandbox}"
IDENTITY="${IDENTITY:-coding-sandbox-pull}"
IMAGE="$REGISTRY.azurecr.io/coding-sandbox:${TAG:-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "Subscription: $(az account show --query name -o tsv)"
read -r -p "Create the sandbox in $RESOURCE_GROUP ($LOCATION)? [y/N] " answer
[[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]] || { echo "Nothing was changed."; exit 1; }

echo "1. Building $IMAGE in the registry"
az acr build --registry "$REGISTRY" --image "${IMAGE#*/}" "$HERE" -o none

echo "2. An identity for pulling the image, with AcrPull on the registry"
az identity create -g "$RESOURCE_GROUP" -n "$IDENTITY" -l "$LOCATION" -o none
IDENTITY_ID=$(az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY" --query id -o tsv)
IDENTITY_PRINCIPAL=$(az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY" --query principalId -o tsv)
az role assignment create --role AcrPull --assignee-object-id "$IDENTITY_PRINCIPAL" \
  --assignee-principal-type ServicePrincipal --scope "$(az acr show -n "$REGISTRY" --query id -o tsv)" -o none

# The identity is for pulling only: sessions cannot use it (the pool's default), so the agent's commands get no
# Azure credentials. Egress is on so pip works; it is not filtered by domain.
echo "3. The session pool"
az containerapp sessionpool create -n "$POOL" -g "$RESOURCE_GROUP" -l "$LOCATION" --environment "$ENVIRONMENT" \
  --container-type CustomContainer --image "$IMAGE" --target-port 8080 --cpu 1.0 --memory 2.0Gi \
  --registry-server "$REGISTRY.azurecr.io" --registry-identity "$IDENTITY_ID" --mi-user-assigned "$IDENTITY_ID" \
  --network-status EgressEnabled --cooldown-period 300 --max-sessions 3 --ready-sessions 0 -o none
POOL_ID=$(az containerapp sessionpool show -n "$POOL" -g "$RESOURCE_GROUP" --query id -o tsv)

echo "4. Who may run commands in it: you, for local runs, and the backend if given"
az role assignment create --role "Azure ContainerApps Session Executor" \
  --assignee-object-id "$(az ad signed-in-user show --query id -o tsv)" --assignee-principal-type User \
  --scope "$POOL_ID" -o none
if [[ -n "${BACKEND_PRINCIPAL_ID:-}" ]]; then
  az role assignment create --role "Azure ContainerApps Session Executor" --assignee-object-id "$BACKEND_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal --scope "$POOL_ID" -o none
fi

ENDPOINT=$(az containerapp sessionpool show -n "$POOL" -g "$RESOURCE_GROUP" --query properties.poolManagementEndpoint -o tsv)
echo
echo "Done. Put these in the lab's .env, or the backend container app's settings:"
echo "  LLM_LAB_SANDBOX=sessions"
echo "  LLM_LAB_SESSIONS_ENDPOINT=$ENDPOINT"
