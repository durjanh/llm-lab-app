#!/usr/bin/env bash
# The app registration the coding sandbox signs callers in with, made if missing, and its app id printed.
# Entra objects live in the tenant, not a resource group, so setup-app.sh and azd's preprovision hook both call this.
#
#   APP_ID=$(examples/coding-sandbox/app-registration.sh llm-lab-coding-sandbox)
#   examples/coding-sandbox/app-registration.sh llm-lab-coding-sandbox --delete
set -euo pipefail

NAME="${1:?Give the display name of the app registration}"
CLI_APP_ID="04b07795-8ddb-461a-bbee-02f9e1bf7b46"  # the Azure CLI, allowed to ask for tokens for the sandbox
APP_ID=$(az ad app list --display-name "$NAME" --query "[0].appId" -o tsv)

if [[ "${2:-}" == "--delete" ]]; then
  [[ -n "$APP_ID" ]] && az ad app delete --id "$APP_ID" && echo "Deleted app registration $NAME ($APP_ID)" >&2
  exit 0
fi

if [[ -z "$APP_ID" ]]; then
  APP_ID=$(az ad app create --display-name "$NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)
fi
OBJECT_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)
az ad sp show --id "$APP_ID" -o none 2>/dev/null || az ad sp create --id "$APP_ID" -o none
SCOPE_ID=$(az ad app show --id "$APP_ID" --query "api.oauth2PermissionScopes[?value=='access'].id | [0]" -o tsv)
if [[ -z "$SCOPE_ID" ]]; then
  SCOPE_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
  az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$OBJECT_ID" --headers "Content-Type=application/json" \
    --body "{\"identifierUris\": [\"api://$APP_ID\"], \"api\": {\"requestedAccessTokenVersion\": 2, \"oauth2PermissionScopes\": [{
      \"id\": \"$SCOPE_ID\", \"value\": \"access\", \"type\": \"User\", \"isEnabled\": true,
      \"adminConsentDisplayName\": \"Run commands in the coding sandbox\",
      \"adminConsentDescription\": \"Lets the lab backend run the coding agent's commands in its sandbox.\",
      \"userConsentDisplayName\": \"Run commands in the coding sandbox\",
      \"userConsentDescription\": \"Lets the lab backend run the coding agent's commands in its sandbox.\"}]}}" >&2
fi
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$OBJECT_ID" --headers "Content-Type=application/json" \
  --body "{\"api\": {\"preAuthorizedApplications\": [{\"appId\": \"$CLI_APP_ID\", \"delegatedPermissionIds\": [\"$SCOPE_ID\"]}]}}" >&2
echo "$APP_ID"
