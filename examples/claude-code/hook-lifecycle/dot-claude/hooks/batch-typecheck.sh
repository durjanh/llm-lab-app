#!/usr/bin/env bash
# PostToolBatch: once after a whole batch of parallel tool calls, before the next model call. If any call in the batch
# edited TypeScript, run the type checker once (not once per file) and send the errors back as context. A "block" here
# would stop the agentic loop altogether, so errors go back as additionalContext instead.
set -uo pipefail
files=$(jq -r '.tool_calls[]? | select(.tool_name | test("^(Edit|Write|MultiEdit)$"))
  | .tool_input.file_path // empty | select(test("\\.tsx?$"))')
[ -n "$files" ] || exit 0
edited=$(grep -c . <<<"$files")
# Run where the nearest tsconfig.json is (in a monorepo it is often in a subfolder), never above the project.
root=$(cd "${CLAUDE_PROJECT_DIR:-.}" && pwd -P)
dir=$(cd "$(dirname "$(head -1 <<<"$files")")" 2>/dev/null && pwd -P) || exit 0
case "$dir" in "$root" | "$root"/*) ;; *) exit 0 ;; esac
while [ ! -f "$dir/tsconfig.json" ] && [ "$dir" != "$root" ] && [ "$dir" != / ]; do dir=$(dirname "$dir"); done
[ -f "$dir/tsconfig.json" ] || exit 0
cd "$dir" || exit 0
if ! out=$(bash -c "${TYPECHECK_CMD:-npx --no-install tsc --noEmit}" 2>&1); then
  jq -n --arg o "$(head -20 <<<"$out")" --arg n "$edited" \
    '{hookSpecificOutput: {hookEventName: "PostToolBatch",
      additionalContext: "The type checker failed after these \($n) edits:\n\($o)"}}'
fi
exit 0
