#!/bin/sh
# After `azd provision`: the lab's .env gets the endpoints, ids and sandbox settings azd just made.
set -eu
# The pipeline has no .env to write: the lab runs on your machine.
[ -n "${GITHUB_ACTIONS:-}" ] && exit 0
python3 ./infra/hooks/write_env.py
