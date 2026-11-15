#!/usr/bin/env bash
# Setup (matcher "init"): runs only with `claude --init-only`, or --init / --maintenance with -p. Installs the project's
# dependencies once, for a CI image or a new machine, and leaves a variable for the sessions that follow.
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund >&2; fi
if [ -f requirements.txt ] && [ -d .venv ]; then .venv/bin/pip install -q -r requirements.txt >&2; fi
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then echo 'export NODE_ENV=development' >>"$CLAUDE_ENV_FILE"; fi
exit 0
