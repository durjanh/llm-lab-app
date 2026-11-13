#!/usr/bin/env bash
# PostToolUse hook: after Claude edits a front-end TypeScript or CSS file, format it with the repo's Prettier
# (120 columns, single quotes). Anything else is left alone. It never blocks: a formatting problem is not a reason to
# undo an edit.
set -uo pipefail

input=$(cat)
case "$input" in *'/frontend/src/'*) ;; *) exit 0 ;; esac  # most edits are elsewhere: no process started for them

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
case "$file" in
  "$root"/frontend/src/*.ts | "$root"/frontend/src/*.tsx | "$root"/frontend/src/*.css) ;;
  *) exit 0 ;;
esac
prettier="$root/frontend/node_modules/.bin/prettier"  # direct, not npx: about 50 ms instead of 270 ms an edit
[ -f "$file" ] && [ -x "$prettier" ] || exit 0

cd "$root/frontend" && "$prettier" --write "$file" >/dev/null 2>&1
exit 0
