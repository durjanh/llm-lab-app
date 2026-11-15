#!/usr/bin/env bash
# PermissionRequest (matcher "Bash"): answer the dialog for you. Read-only git commands are allowed; a download piped
# into a shell is denied; anything else gets no answer, so you see the dialog as usual. Exit code 2 does nothing on
# this event, so the answer is JSON. An allow here never overrides a deny rule.
set -uo pipefail
cmd=$(jq -r '.tool_input.command // empty')
answer() { jq -n --argjson d "$1" '{hookSpecificOutput: {hookEventName: "PermissionRequest", decision: $d}}'; }
if [[ "$cmd" =~ (curl|wget)[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z)?sh ]]; then
  answer '{"behavior": "deny", "message": "Piping a download into a shell is not allowed. Download it, read it, then run it."}'
elif [[ "$cmd" =~ ^git[[:space:]]+(status|diff|log|show|branch)([[:space:]]|$) ]] && [[ ! "$cmd" =~ [\;\&\|\>\<\`]|\$\( ]]; then
  answer '{"behavior": "allow"}'
fi
exit 0
