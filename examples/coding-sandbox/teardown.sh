#!/usr/bin/env bash
# Takes the coding agent's sandbox down: everything setup-app.sh (option B) and setup.sh (option A) create, and
# nothing else. The resource group and the lab's other resources (AI, Speech, Search) stay. It lists what it found
# and asks before deleting; the environment is kept if anything else still runs in it.
#
#   examples/coding-sandbox/teardown.sh
#   KEEP_REGISTRY=1 examples/coding-sandbox/teardown.sh   # keep the registry and its image, to set up again faster
set -uo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-llm-lab}"
ENVIRONMENT="${ENVIRONMENT:-cae-llm-lab}"
APP="${APP:-coding-sandbox}"
POOL="${POOL:-coding-sandbox}"
IDENTITY="${IDENTITY:-coding-sandbox-pull}"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
REGISTRY="${REGISTRY:-acrllmlab${SUBSCRIPTION_ID:0:6}}"

exists() { "$@" -o none 2>/dev/null; }
found=()
exists az containerapp show -n "$APP" -g "$RESOURCE_GROUP" && found+=("container app $APP")
exists az containerapp sessionpool show -n "$POOL" -g "$RESOURCE_GROUP" && found+=("session pool $POOL")
APP_ID=$(az ad app list --display-name "llm-lab-coding-sandbox" --query "[0].appId" -o tsv 2>/dev/null)
[[ -n "$APP_ID" ]] && found+=("app registration llm-lab-coding-sandbox ($APP_ID)")
exists az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY" && found+=("identity $IDENTITY")
[[ "${KEEP_REGISTRY:-}" != "1" ]] && exists az acr show -n "$REGISTRY" -g "$RESOURCE_GROUP" && found+=("registry $REGISTRY and its images")
exists az containerapp env show -n "$ENVIRONMENT" -g "$RESOURCE_GROUP" && found+=("environment $ENVIRONMENT, if nothing else is in it")

echo "Subscription: $(az account show --query name -o tsv), $RESOURCE_GROUP"
if [[ ${#found[@]} -eq 0 ]]; then
  echo "Nothing of the coding sandbox is there."
  exit 0
fi
printf 'Will delete:\n'; printf '  - %s\n' "${found[@]}"
if [[ "${YES:-}" != "1" ]]; then
  read -r -p "Delete these? [y/N] " answer
  [[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]] || { echo "Nothing was changed."; exit 1; }
fi

exists az containerapp show -n "$APP" -g "$RESOURCE_GROUP" && \
  { echo "Deleting container app $APP"; az containerapp delete -n "$APP" -g "$RESOURCE_GROUP" --yes -o none; }
exists az containerapp sessionpool show -n "$POOL" -g "$RESOURCE_GROUP" && \
  { echo "Deleting session pool $POOL"; az containerapp sessionpool delete -n "$POOL" -g "$RESOURCE_GROUP" --yes -o none; }
[[ -n "$APP_ID" ]] && { echo "Deleting app registration $APP_ID"; az ad app delete --id "$APP_ID"; }
exists az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY" && \
  { echo "Deleting identity $IDENTITY"; az identity delete -g "$RESOURCE_GROUP" -n "$IDENTITY"; }
if [[ "${KEEP_REGISTRY:-}" != "1" ]] && exists az acr show -n "$REGISTRY" -g "$RESOURCE_GROUP"; then
  echo "Deleting registry $REGISTRY"; az acr delete -n "$REGISTRY" -g "$RESOURCE_GROUP" --yes -o none
fi
if exists az containerapp env show -n "$ENVIRONMENT" -g "$RESOURCE_GROUP"; then
  ENV_ID=$(az containerapp env show -n "$ENVIRONMENT" -g "$RESOURCE_GROUP" --query id -o tsv)
  others=$(az resource list -g "$RESOURCE_GROUP" --query "[?properties.environmentId=='$ENV_ID' || properties.managedEnvironmentId=='$ENV_ID'].name" -o tsv)
  if [[ -n "$others" ]]; then
    echo "Keeping environment $ENVIRONMENT: still in use by $others"
  else
    echo "Deleting environment $ENVIRONMENT"; az containerapp env delete -n "$ENVIRONMENT" -g "$RESOURCE_GROUP" --yes -o none
  fi
fi
echo "An image published with publish-image.sh stays on GitHub: delete it under Packages if you no longer want it."
echo "Done. Remove LLM_LAB_SANDBOX, LLM_LAB_SESSIONS_ENDPOINT and LLM_LAB_SESSIONS_SCOPE from the lab's .env."
