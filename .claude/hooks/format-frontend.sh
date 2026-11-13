#!/usr/bin/env bash
# PostToolUse hook: after Claude edits a front-end TypeScript or CSS file, format it with the repo's Prettier
# (120 columns, single quotes). Anything else is left alone. It never blocks: a formatting problem is not a reason to
# undo an edit.
set -uo pipefail

file=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))' 2>/dev/null)
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"

case "$file" in
  "$root"/frontend/src/*.ts | "$root"/frontend/src/*.tsx | "$root"/frontend/src/*.css) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0

cd "$root/frontend" && npx --no-install prettier --write "$file" >/dev/null 2>&1
exit 0
