#!/usr/bin/env bash
# PermissionDenied: auto mode refused a tool call. Keep a record, so you can see what it refuses before changing its
# rules. The denial stands whatever this prints; {"retry": true} would only tell the model it may try another way.
set -uo pipefail
log="${CLAUDE_PROJECT_DIR:-.}/.claude/denied.jsonl"
mkdir -p "$(dirname "$log")"
jq -c '{t: (now | todate), tool: .tool_name, input: .tool_input, reason: .reason}' >>"$log"
exit 0
