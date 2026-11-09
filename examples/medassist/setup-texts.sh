#!/usr/bin/env bash
# Adds MedAssist's real texts to the lab's own resource group: Communication Services, the reminders table and the
# reminder Function, each tagged lab-part=medassist-texts. Deploys the Function's code, and adds MEDASSIST_SMS_ENDPOINT
# and MEDASSIST_REMINDERS_TABLE to the lab's .env, leaving every other line alone. Safe to run again: it updates.
#
#   examples/medassist/setup-texts.sh                 # into rg-llm-lab
#   RG=my-group examples/medassist/setup-texts.sh     # into another existing group
#
# Then: register the sender name ("Durjan Lab") in the portal, and put your own mobile in .env as MEDASSIST_SMS_TO.
# teardown-texts.sh removes what this made, and nothing else. Needs the Azure CLI, signed in (az login).
set -euo pipefail
cd "$(dirname "$0")"
RG="${RG:-rg-llm-lab}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

location=$(az group show -n "$RG" --query location -o tsv)
for ns in Microsoft.Communication Microsoft.Web; do  # once per subscription; registering again does nothing
  [ "$(az provider show -n "$ns" --query registrationState -o tsv)" = "Registered" ] || az provider register -n "$ns" --wait
done

echo "Deploying Communication Services, the reminders table and the Function into $RG ($location)..."
az deployment group create -g "$RG" -n medassist-texts -f infra/main.bicep \
  -p principalId="$(az ad signed-in-user show --query id -o tsv)" location="$location" \
     aiServicesName="$(az cognitiveservices account list -g "$RG" \
       --query "[?kind=='AIServices' && location=='$location'] | [0].name" -o tsv)" \
  --query properties.outputs -o json > "$OUT/outputs.json"
app=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["functionAppName"]["value"])' "$OUT/outputs.json")

echo "Deploying the reminder Function's code to $app (Azure builds it)..."
(cd reminders && zip -qr "$OUT/reminders.zip" . -x '.venv/*' '*__pycache__*' 'local.settings.json')
for attempt in 1 2 3; do  # the deployment service sometimes answers 503 while the app is new
  if az functionapp deployment source config-zip -g "$RG" -n "$app" --src "$OUT/reminders.zip" --build-remote true \
       -o none; then
    break
  fi
  [ "$attempt" = 3 ] && { echo "The Function's code did not deploy. Run this script again." >&2; exit 1; }
  echo "Trying again in 30 seconds..."; sleep 30
done

python3 ../../infra/hooks/write_env.py --only MEDASSIST_SMS_ENDPOINT,MEDASSIST_REMINDERS_TABLE --values "$OUT/outputs.json"
grep -q '^MEDASSIST_SMS_TO=.' ../../.env || echo "Now add your own mobile to .env as MEDASSIST_SMS_TO, and restart the backend."
echo "Register the sender name in the portal before UK texts can be delivered (see README.md)."
