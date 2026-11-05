#!/usr/bin/env bash
# Option B: the coding agent's sandbox as one container app on the Consumption plan, shared by every agent session
# (each in its own folder), scaled to zero when idle. Same image and server as the session pool (setup.sh, option A);
# moving to A later means running setup.sh and changing LLM_LAB_SESSIONS_ENDPOINT and LLM_LAB_SESSIONS_SCOPE.
#
# Keyless throughout. The image comes from the Azure registry, pulled with a managed identity that no container can
# use (identity lifecycle None), or from a public registry with no identity at all (IMAGE=ghcr.io/..., made by
# publish-image.sh). Either way the agent's commands get no Azure credentials. Calls are checked by Container Apps' built-in sign-in:
# a token for this sandbox's own app registration, from a principal on the allowed list (you, and the backend's
# identity if given). Running it again is safe: it creates what is missing and updates the rest.
#
#   ./setup-app.sh                                  # rg-llm-lab in uksouth
#   BACKEND_PRINCIPAL_ID=<object id> ./setup-app.sh # also allow the deployed backend's managed identity
#   IMAGE=ghcr.io/<you>/coding-sandbox:1 ./setup-app.sh   # a public image: no registry or identity in Azure
#
# This creates billable resources in the subscription `az account show` names: a Basic registry (about £4 a month,
# not with IMAGE), a Container Apps environment, and the app, billed per second while it runs and nothing while
# scaled to zero.
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-llm-lab}"
LOCATION="${LOCATION:-uksouth}"
ENVIRONMENT="${ENVIRONMENT:-cae-llm-lab}"
APP="${APP:-coding-sandbox}"
IDENTITY="${IDENTITY:-coding-sandbox-pull}"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
REGISTRY="${REGISTRY:-acrllmlab${SUBSCRIPTION_ID:0:6}}"
if [[ -n "${IMAGE:-}" ]]; then
  OWN_REGISTRY=0  # a public image, such as one publish-image.sh pushed to ghcr.io: pulled with no credentials
else
  OWN_REGISTRY=1
  IMAGE="$REGISTRY.azurecr.io/coding-sandbox:${TAG:-1}"
fi
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "Subscription: $(az account show --query name -o tsv), $RESOURCE_GROUP in $LOCATION"
if [[ "${YES:-}" != "1" ]]; then
  read -r -p "Create or update the coding sandbox there? [y/N] " answer
  [[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]] || { echo "Nothing was changed."; exit 1; }
fi

if [[ "$OWN_REGISTRY" == "1" ]]; then
  echo "1. Registry $REGISTRY, and the image (an Azure build, linux/amd64)"
  az acr show -n "$REGISTRY" -o none 2>/dev/null || az acr create -n "$REGISTRY" -g "$RESOURCE_GROUP" -l "$LOCATION" --sku Basic -o none
  az acr build --registry "$REGISTRY" --image "${IMAGE#*/}" --platform linux/amd64 "$HERE" -o none

  echo "2. An identity for pulling the image, with AcrPull on the registry"
  az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY" -o none 2>/dev/null || az identity create -g "$RESOURCE_GROUP" -n "$IDENTITY" -l "$LOCATION" -o none
  IDENTITY_ID=$(az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY" --query id -o tsv)
  IDENTITY_PRINCIPAL=$(az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY" --query principalId -o tsv)
  az role assignment create --role AcrPull --assignee-object-id "$IDENTITY_PRINCIPAL" --assignee-principal-type ServicePrincipal \
    --scope "$(az acr show -n "$REGISTRY" --query id -o tsv)" -o none
else
  echo "1-2. Using $IMAGE: a public image, so no registry or pull identity in Azure"
  if [[ "$IMAGE" == ghcr.io/* ]]; then  # can it be pulled with no credentials? Ask for its manifest anonymously.
    REPO=$(echo "$IMAGE" | sed -E 's#^ghcr.io/([^:]+):.*#\1#'); TAG_=${IMAGE##*:}
    ANON=$(curl -s "https://ghcr.io/token?scope=repository:$REPO:pull" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token", ""))')
    if ! curl -sf -o /dev/null -H "Authorization: Bearer $ANON" \
        -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
        "https://ghcr.io/v2/$REPO/manifests/$TAG_"; then
      echo "   $IMAGE cannot be pulled without credentials. Make the package public on GitHub, then run this again:"
      echo "   https://github.com/users/${REPO%%/*}/packages/container/${REPO#*/}/settings"
      exit 1
    fi
  fi
fi

echo "3. The Container Apps environment $ENVIRONMENT (Consumption, no log workspace)"
az containerapp env show -n "$ENVIRONMENT" -g "$RESOURCE_GROUP" -o none 2>/dev/null || \
  az containerapp env create -n "$ENVIRONMENT" -g "$RESOURCE_GROUP" -l "$LOCATION" --logs-destination none -o none

echo "4. The app registration the sandbox signs callers in with"
APP_ID=$("$HERE/app-registration.sh" "llm-lab-coding-sandbox")

echo "5. The container app $APP: scaled to zero when idle, one replica (sessions keep their state in it)"
PULL=()
[[ "$OWN_REGISTRY" == "1" ]] && PULL=(--registry-server "$REGISTRY.azurecr.io" --registry-identity "$IDENTITY_ID" --user-assigned "$IDENTITY_ID")
if ! az containerapp show -n "$APP" -g "$RESOURCE_GROUP" -o none 2>/dev/null; then
  az containerapp create -n "$APP" -g "$RESOURCE_GROUP" --environment "$ENVIRONMENT" --image "$IMAGE" ${PULL[@]+"${PULL[@]}"} \
    --ingress external --target-port 8080 --min-replicas 0 --max-replicas 1 --cpu 2 --memory 4Gi -o none
else
  az containerapp update -n "$APP" -g "$RESOURCE_GROUP" --image "$IMAGE" -o none
fi
APP_RESOURCE_ID=$(az containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query id -o tsv)
if [[ "$OWN_REGISTRY" == "1" ]]; then
  # The pull identity may be used for the image only: no container can ask it for a token.
  az rest --method PATCH --url "https://management.azure.com$APP_RESOURCE_ID?api-version=2025-01-01" \
    --body "{\"properties\": {\"configuration\": {\"identitySettings\": [{\"identity\": \"$IDENTITY_ID\", \"lifecycle\": \"None\"}]}}}" -o none
else
  # Moving off the Azure registry: the app no longer needs it, or the identity that pulled from it. The identity's
  # lifecycle setting names it, so that goes first, or the identity could not be removed.
  az rest --method PATCH --url "https://management.azure.com$APP_RESOURCE_ID?api-version=2025-01-01" \
    --body '{"properties": {"configuration": {"identitySettings": []}}}' -o none
  for server in $(az containerapp registry list -n "$APP" -g "$RESOURCE_GROUP" --query "[].server" -o tsv 2>/dev/null); do
    az containerapp registry remove -n "$APP" -g "$RESOURCE_GROUP" --server "$server" -o none
  done
  for identity in $(az containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query "keys(identity.userAssignedIdentities || \`{}\`)" -o tsv); do
    az containerapp identity remove -n "$APP" -g "$RESOURCE_GROUP" --user-assigned "$identity" -o none
  done
  if az acr show -n "$REGISTRY" -g "$RESOURCE_GROUP" -o none 2>/dev/null; then
    echo "   The Azure registry $REGISTRY is no longer used. To stop paying for it:"
    echo "   az acr delete -n $REGISTRY -g $RESOURCE_GROUP --yes"
  fi
  if az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY" -o none 2>/dev/null; then
    echo "   The pull identity $IDENTITY is no longer used: az identity delete -g $RESOURCE_GROUP -n $IDENTITY"
  fi
fi

echo "6. Sign-in: a token for the app registration, from you or the backend, or 401"
ALLOWED="\"$(az ad signed-in-user show --query id -o tsv)\""
[[ -n "${BACKEND_PRINCIPAL_ID:-}" ]] && ALLOWED="$ALLOWED, \"$BACKEND_PRINCIPAL_ID\""
az rest --method PUT --url "https://management.azure.com$APP_RESOURCE_ID/authConfigs/current?api-version=2025-01-01" \
  --body "{\"properties\": {\"platform\": {\"enabled\": true},
    \"globalValidation\": {\"unauthenticatedClientAction\": \"Return401\"},
    \"identityProviders\": {\"azureActiveDirectory\": {\"enabled\": true,
      \"registration\": {\"clientId\": \"$APP_ID\", \"openIdIssuer\": \"https://login.microsoftonline.com/$TENANT_ID/v2.0\"},
      \"validation\": {\"allowedAudiences\": [\"api://$APP_ID\", \"$APP_ID\"],
        \"defaultAuthorizationPolicy\": {\"allowedPrincipals\": {\"identities\": [$ALLOWED]}}}}}}}" -o none

FQDN=$(az containerapp show -n "$APP" -g "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)
echo
echo "Done. Put these in the lab's .env, or the backend container app's settings:"
echo "  LLM_LAB_SANDBOX=sessions"
echo "  LLM_LAB_SESSIONS_ENDPOINT=https://$FQDN"
echo "  LLM_LAB_SESSIONS_SCOPE=api://$APP_ID/.default"
