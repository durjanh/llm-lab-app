#!/usr/bin/env bash
# Removes what setup-texts.sh made (the resources tagged lab-part=medassist-texts) and the two lines it added to .env.
# Nothing else in the group is touched. Their role assignments go with them.
#
#   examples/medassist/teardown-texts.sh
#   RG=my-group examples/medassist/teardown-texts.sh
set -euo pipefail
cd "$(dirname "$0")"
RG="${RG:-rg-llm-lab}"

ids=$(az resource list -g "$RG" --query "[?tags.\"lab-part\"=='medassist-texts'].id" -o tsv)
if [ -z "$ids" ]; then
  echo "Nothing tagged lab-part=medassist-texts in $RG."
else
  echo "Removing from $RG:"; echo "$ids" | sed 's#.*/#  #'
  # The Function app before its plan, and everything before the storage account the app uses.
  for kind in Microsoft.Web/sites Microsoft.Web/serverFarms Microsoft.Communication/communicationServices \
              Microsoft.Storage/storageAccounts; do
    for id in $(echo "$ids" | grep -i "/providers/$kind/" || true); do
      az resource delete --ids "$id" -o none
    done
  done
fi
python3 ../../infra/hooks/write_env.py --only MEDASSIST_SMS_ENDPOINT,MEDASSIST_REMINDERS_TABLE --remove
