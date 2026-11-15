#!/usr/bin/env bash
# PostToolBatch: once after a whole batch of parallel tool calls, before the next model call. If any call in the batch
# edited TypeScript, run the type checker once (not once per file) and send the errors back as context. A "block" here
# would stop the agentic loop altogether, so errors go back as additionalContext instead.
set -uo pipefail
edited=$(jq -r '[.tool_calls[]? | select(.tool_name | test("^(Edit|Write|MultiEdit)$"))
  | .tool_input.file_path // empty | select(test("\\.tsx?$"))] | length')
[ "${edited:-0}" -gt 0 ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
if ! out=$(${TYPECHECK_CMD:-npx tsc --noEmit} 2>&1); then
  jq -n --arg o "$(head -20 <<<"$out")" --arg n "$edited" \
    '{hookSpecificOutput: {hookEventName: "PostToolBatch",
      additionalContext: "The type checker failed after these \($n) edits:\n\($o)"}}'
fi
exit 0
