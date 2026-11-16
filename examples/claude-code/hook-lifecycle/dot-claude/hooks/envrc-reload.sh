#!/usr/bin/env bash
# FileChanged (matcher ".envrc") and CwdChanged: load simple `export NAME=value` lines from .envrc into the session's
# environment through CLAUDE_ENV_FILE. The file is never run as a script, and CLAUDE_ENV_FILE is sourced by later Bash
# calls, so only lines whose value is a plain word or a simple quoted string are copied; anything else is skipped.
set -uo pipefail
input=$(cat)
file=$(jq -r '.file_path // ((.new_cwd // empty) + "/.envrc")' <<<"$input")
[ -n "${CLAUDE_ENV_FILE:-}" ] && [ -f "$file" ] || exit 0
# A bare word, or a quoted string with no $, backtick, backslash or quote inside: nothing a shell would run or expand.
value='([A-Za-z0-9_./:@%+,=-]*|"[^"$`\\]*"|'"'"'[^'"'"']*'"'"')'
grep -E "^export [A-Za-z_][A-Za-z0-9_]*=$value\$" "$file" >>"$CLAUDE_ENV_FILE"
exit 0
