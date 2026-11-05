#!/bin/sh
# After `azd down`: the resource group is gone; the app registrations (in Entra), the pipeline's subscription role
# and the .env lines go too.
set -eu
./examples/coding-sandbox/app-registration.sh "llm-lab-coding-sandbox-${AZURE_ENV_NAME}" --delete
azd env set SANDBOX_APP_ID ""
./infra/pipeline.sh --delete
python3 ./infra/hooks/write_env.py --remove
