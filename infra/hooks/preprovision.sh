#!/bin/sh
# Before `azd provision`: catch the free tiers a subscription allows only one of, and make the coding sandbox's
# app registration (an Entra object, which Bicep in a resource group cannot make), passing its id to the Bicep.
set -eu

RG="rg-${AZURE_ENV_NAME}"
ENV="${AZURE_ENV_NAME}"

# azd down deletes the whole group. Never provision into a group azd did not make for this environment, such as a
# hand-made rg-llm-lab when the environment is called llm-lab.
owner=$(az group show -n "$RG" --query 'tags."azd-env-name"' -o tsv 2>/dev/null || echo "none")
if [ "$owner" != "none" ] && [ "$owner" != "$ENV" ]; then
  echo "$RG already exists and azd did not make it for this environment, so azd down would delete what is in it."
  echo "Use another environment name: azd env new <name>"
  exit 1
fi

# The free tiers: one free search service per subscription, one free Speech resource per region. This
# environment's own (tagged with its name) does not count.
if [ "${AZURE_SEARCH_SKU:-free}" = "free" ]; then
  other=$(az resource list --resource-type Microsoft.Search/searchServices --query "[?sku.name=='free' && tags.\"azd-env-name\"!='$ENV'].name | [0]" -o tsv 2>/dev/null || true)
  if [ -n "$other" ]; then
    echo "A subscription has one free search service, and $other already is it."
    echo "Delete it (az search service delete -n $other -g <its group>), or use the paid tier: azd env set AZURE_SEARCH_SKU basic"
    exit 1
  fi
fi
if [ "${AZURE_SPEECH_SKU:-S0}" = "F0" ]; then
  other=$(az cognitiveservices account list --query "[?kind=='SpeechServices' && sku.name=='F0' && location=='${AZURE_LOCATION:-uksouth}' && tags.\"azd-env-name\"!='$ENV'].name | [0]" -o tsv 2>/dev/null || true)
  if [ -n "$other" ]; then
    echo "A subscription has one free Speech resource per region, and $other already is it. Use S0: azd env set AZURE_SPEECH_SKU S0"
    exit 1
  fi
fi

# Communication Services (MedAssist's texts) and Functions (its reminders) need their resource providers registered
# in the subscription, once. Registering one that already is does nothing.
for ns in Microsoft.Communication Microsoft.Web; do
  [ "$(az provider show -n "$ns" --query registrationState -o tsv 2>/dev/null)" = "Registered" ] \
    || az provider register --namespace "$ns" --wait
done

# The person who runs the lab, given its roles. Not AZURE_PRINCIPAL_ID: azd fills that with whoever is signed in,
# which in the GitHub pipeline is the pipeline itself.
if [ -z "${LAB_PRINCIPAL_ID:-}" ]; then
  azd env set LAB_PRINCIPAL_ID "$(az ad signed-in-user show --query id -o tsv)"
fi

if [ -n "${GITHUB_ACTIONS:-}" ]; then
  # The pipeline cannot read or change Entra. It reuses the registration your first azd up made.
  if [ -z "${SANDBOX_APP_ID:-}" ] || [ -z "${LAB_PRINCIPAL_ID:-}" ]; then
    echo "Set the SANDBOX_APP_ID and LAB_PRINCIPAL_ID repository variables: infra/pipeline.sh does it."
    exit 1
  fi
  exit 0
fi
echo "The coding sandbox's app registration"
APP_ID=$(./examples/coding-sandbox/app-registration.sh "llm-lab-coding-sandbox-${AZURE_ENV_NAME}")
azd env set SANDBOX_APP_ID "$APP_ID"
