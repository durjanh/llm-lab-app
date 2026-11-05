#!/usr/bin/env bash
# Lets this repository's GitHub Actions workflow (.github/workflows/infra.yml) run `azd provision` and the evaluation
# gate. It signs in with OpenID Connect: GitHub vouches for the run, Entra trusts that, and no secret is stored.
#
#   infra/pipeline.sh            # after a first `azd up` from your machine, in the same azd environment
#   infra/pipeline.sh --delete   # azd down's postdown hook runs this too
#
# It makes the app registration llm-lab-pipeline-<env>, trusts tokens for this repository's main branch only, gives
# it the narrowest roles that still deploy the template, and sets the workflow's repository variables.
set -euo pipefail

value() { azd env get-value "$1" 2>/dev/null || true; }
ENV_NAME="${AZURE_ENV_NAME:-$(value AZURE_ENV_NAME)}"
[[ -n "$ENV_NAME" ]] || { echo "Run azd up first: the pipeline keeps an environment you made up to date." >&2; exit 1; }
SUB="${AZURE_SUBSCRIPTION_ID:-$(value AZURE_SUBSCRIPTION_ID)}"
NAME="llm-lab-pipeline-$ENV_NAME"
APP_ID=$(az ad app list --display-name "$NAME" --query "[0].appId" -o tsv)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
VARIABLES=(AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID AZURE_ENV_NAME AZURE_LOCATION AZURE_MEDIA_LOCATION
  AZURE_SEARCH_SKU AZURE_SPEECH_SKU SANDBOX_APP_ID SANDBOX_IMAGE LAB_PRINCIPAL_ID LAB_PIPELINE_PRINCIPAL_ID)

if [[ "${1:-}" == "--delete" ]]; then
  [[ -z "$APP_ID" ]] && exit 0
  SP=$(az ad sp show --id "$APP_ID" --query id -o tsv 2>/dev/null || true)
  if [[ -n "$SP" ]]; then
    ids=$(az role assignment list --assignee "$SP" --all --query "[].id" -o tsv)
    [[ -n "$ids" ]] && az role assignment delete --ids $ids
  fi
  az ad app delete --id "$APP_ID"
  echo "Deleted app registration $NAME ($APP_ID) and its roles" >&2
  azd env set LAB_PIPELINE_PRINCIPAL_ID "" 2>/dev/null || true
  if [[ -n "$REPO" ]]; then
    for v in "${VARIABLES[@]}"; do gh variable delete "$v" --repo "$REPO" 2>/dev/null || true; done
    echo "Removed the workflow's variables from $REPO" >&2
  fi
  exit 0
fi

[[ -n "$REPO" ]] || { echo "Sign the GitHub CLI in first: gh auth login" >&2; exit 1; }
RG=$(value AZURE_RESOURCE_GROUP)
ME=$(value LAB_PRINCIPAL_ID)
PROJECT_MI=$(value FOUNDRY_PROJECT_PRINCIPAL_ID)  # the template gives the project's identity its search roles
[[ -n "$RG" && -n "$ME" && -n "$PROJECT_MI" ]] || { echo "This azd environment has not been provisioned: run azd up first." >&2; exit 1; }
TENANT=$(az account show --query tenantId -o tsv)

# 1. The pipeline's identity: an app registration and its service principal.
if [[ -z "$APP_ID" ]]; then
  APP_ID=$(az ad app create --display-name "$NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)
fi
az ad sp show --id "$APP_ID" -o none 2>/dev/null || az ad sp create --id "$APP_ID" -o none
SP=$(az ad sp show --id "$APP_ID" --query id -o tsv)

# 2. Trust GitHub's token for runs on main, and nothing else: not other branches, not pull requests.
SUBJECT="repo:$REPO:ref:refs/heads/main"
if [[ -z "$(az ad app federated-credential list --id "$APP_ID" --query "[?subject=='$SUBJECT'].name | [0]" -o tsv)" ]]; then
  az ad app federated-credential create --id "$APP_ID" -o none --parameters "{\"name\": \"github-main\",
    \"issuer\": \"https://token.actions.githubusercontent.com\", \"subject\": \"$SUBJECT\",
    \"audiences\": [\"api://AzureADTokenExchange\"]}"
fi

# 3. Roles. Contributor on the subscription, because the template makes the resource group; Contributor cannot
#    grant access. Granting is a separate role, on the lab's group only, with a condition: only the lab's nine
#    roles, and only to you, the pipeline or the Foundry project's identity. So a changed template cannot make
#    anyone else an Owner.
grant() {  # role, scope, [condition]
  if [[ -z "$(az role assignment list --assignee "$SP" --role "$1" --scope "$2" --query "[0].id" -o tsv)" ]]; then
    az role assignment create --assignee-object-id "$SP" --assignee-principal-type ServicePrincipal \
      --role "$1" --scope "$2" ${3:+--condition "$3" --condition-version 2.0} -o none
  fi
}
LAB_ROLES="5e0bd9bd-7b93-4f28-af87-19fc36ad61bd, f2dc8367-1007-4938-bd23-fe263f013447, a97b65f3-24c7-4388-baec-2e87135dc908,\
 53ca6127-db72-4b80-b1b0-d745d6d5456d, 8ebe5a00-799e-43f5-93ac-243d3dce84a7, 7ca78c08-252a-4471-8644-bb5ff32d4ba0,\
 acdd72a7-3385-48ef-bd42-f606fba81ae7,\
 0e75ca1e-0464-4b4d-8b93-68208a576181,\
 1407120a-92aa-4202-b7e9-c0e197c71c8f"
CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR \
(@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$LAB_ROLES} \
AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {$ME, $SP, $PROJECT_MI})) \
AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR \
(@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$LAB_ROLES}))"
grant Contributor "/subscriptions/$SUB"
grant "Role Based Access Control Administrator" "/subscriptions/$SUB/resourceGroups/$RG" "$CONDITION"

# 4. The workflow's settings, as repository variables: none of them is a secret.
azd env set LAB_PIPELINE_PRINCIPAL_ID "$SP"
setting() { local v; v=$(value "$1"); echo "${v:-$2}"; }
declare_var() { gh variable set "$1" --body "$2" --repo "$REPO"; }
declare_var AZURE_CLIENT_ID "$APP_ID"
declare_var AZURE_TENANT_ID "$TENANT"
declare_var AZURE_SUBSCRIPTION_ID "$SUB"
declare_var AZURE_ENV_NAME "$ENV_NAME"
declare_var AZURE_LOCATION "$(setting AZURE_LOCATION uksouth)"
declare_var AZURE_MEDIA_LOCATION "$(setting AZURE_MEDIA_LOCATION swedencentral)"
declare_var AZURE_SEARCH_SKU "$(setting AZURE_SEARCH_SKU free)"
declare_var AZURE_SPEECH_SKU "$(setting AZURE_SPEECH_SKU S0)"
declare_var SANDBOX_APP_ID "$(setting SANDBOX_APP_ID '')"
declare_var SANDBOX_IMAGE "$(setting SANDBOX_IMAGE ghcr.io/durjanh/coding-sandbox:1)"
declare_var LAB_PRINCIPAL_ID "$ME"
declare_var LAB_PIPELINE_PRINCIPAL_ID "$SP"

echo "Done. Push to main (or run the infra workflow by hand) and GitHub Actions provisions $RG and runs the gate."
