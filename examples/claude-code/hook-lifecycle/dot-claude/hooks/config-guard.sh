#!/usr/bin/env bash
# ConfigChange (matcher "project_settings|local_settings"): refuse a mid-session change that turns the project's hooks
# off: disableAllHooks in either file, or the project file losing its hooks. A local settings file with no hooks at all
# is normal (it usually holds only permissions), so that is allowed. Exit code 2 blocks the change (it cannot block policy settings). The reason is not shown to anyone, so it is
# logged to standard error for your own debugging only.
set -uo pipefail
input=$(cat)
file=$(jq -r '.file_path // empty' <<<"$input")
[ -n "$file" ] && [ -f "$file" ] || exit 0
src=$(jq -r '.source // empty' <<<"$input")
if jq -e --arg s "$src" '.disableAllHooks == true
    or ($s == "project_settings" and ((.hooks // {}) | length) == 0)' "$file" >/dev/null 2>&1; then
  echo "Blocked a change to $file: it would turn the project hooks off." >&2
  exit 2
fi
exit 0
