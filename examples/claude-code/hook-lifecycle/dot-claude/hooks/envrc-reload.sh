#!/usr/bin/env bash
# FileChanged (matcher ".envrc") and CwdChanged: load simple `export NAME=value` lines from .envrc into the session's
# environment through CLAUDE_ENV_FILE. The file is never run as a script: a line with a command substitution is skipped.
set -uo pipefail
input=$(cat)
file=$(jq -r '.file_path // ((.new_cwd // empty) + "/.envrc")' <<<"$input")
[ -n "${CLAUDE_ENV_FILE:-}" ] && [ -f "$file" ] || exit 0
grep -E '^export [A-Za-z_][A-Za-z0-9_]*=' "$file" | grep -v -e '\$(' -e '`' >>"$CLAUDE_ENV_FILE"
exit 0
