#!/usr/bin/env bash
# Connects the practice's phone line: calls to the lab's number reach MedAssist through your dev tunnel.
#
#   examples/medassist/setup-phone-line.sh https://<your-tunnel>.devtunnels.ms
#   examples/medassist/setup-phone-line.sh --remove
#
# The first run makes the line's token (MEDASSIST_PHONE_TOKEN) and puts it in .env: restart the backend and run this
# again. The second run tells Event Grid to send the lab's incoming calls to the backend; Event Grid checks the address
# first, so the backend and the tunnel must be running. A new tunnel address means running it again.
# Needs setup-texts.sh to have made the Communication Services resource, a phone number bought in it, and az login.
set -euo pipefail
cd "$(dirname "$0")"
RG="${RG:-rg-llm-lab}"
ENV_FILE=../../.env
SUB=medassist-incoming-calls

acs=$(az resource list -g "$RG" --resource-type Microsoft.Communication/communicationServices \
      --query "[?tags.\"lab-part\"=='medassist-texts'] | [0].id" -o tsv)
[ -n "$acs" ] || { echo "No Communication Services resource in $RG. Run setup-texts.sh first." >&2; exit 1; }

if [ "${1:-}" = "--remove" ]; then
  az eventgrid event-subscription delete --name "$SUB" --source-resource-id "$acs" 2>/dev/null && echo "Removed."
  exit 0
fi
url="${1:?Give the https address of the tunnel, for example https://abc123-8000.uks1.devtunnels.ms}"
url="${url%/}"

token=$(sed -n 's/^MEDASSIST_PHONE_TOKEN=//p' "$ENV_FILE" 2>/dev/null | tail -1)
if [ -z "$token" ]; then
  token=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
  out=$(mktemp); trap 'rm -f "$out"' EXIT
  printf '{"MEDASSIST_PHONE_TOKEN": {"value": "%s"}}' "$token" > "$out"
  python3 ../../infra/hooks/write_env.py --only MEDASSIST_PHONE_TOKEN --values "$out"
  echo "Made the line's token. Restart the backend, keep the tunnel running, and run this again."
  exit 0
fi

curl -sf "$url/api/medassist/phone/incoming?token=$token" -H 'content-type: application/json' \
  -d '[{"eventType": "Microsoft.EventGrid.SubscriptionValidationEvent", "data": {"validationCode": "check"}}]' \
  | grep -q check || { echo "The backend did not answer at $url with this token. Is it restarted, and is the tunnel up?" >&2; exit 1; }

echo "Sending the lab number's incoming calls to $url ..."
az eventgrid event-subscription create --name "$SUB" --source-resource-id "$acs" \
  --endpoint "$url/api/medassist/phone/incoming?token=$token" \
  --included-event-types Microsoft.Communication.IncomingCall -o none
grep -q '^AFTERCARE_CALLBACK_URL=' "$ENV_FILE" || echo "Also set AFTERCARE_CALLBACK_URL=$url in .env and restart the backend."
echo "Ring the lab's number from your own phone (AFTERCARE_CALL_TO)."
