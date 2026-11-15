#!/usr/bin/env bash
# ConfigChange (matcher "project_settings|local_settings"): refuse a mid-session change that turns the project's hooks
# off. Exit code 2 blocks the change (it cannot block policy settings). The reason is not shown to anyone, so it is
# logged to standard error for your own debugging only.
set -uo pipefail
file=$(jq -r '.file_path // empty')
[ -n "$file" ] && [ -f "$file" ] || exit 0
if jq -e '.disableAllHooks == true or (has("hooks") | not)' "$file" >/dev/null 2>&1; then
  echo "Blocked a change to $file: it would turn the project hooks off." >&2
  exit 2
fi
exit 0
