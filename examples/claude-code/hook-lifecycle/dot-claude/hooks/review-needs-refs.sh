#!/usr/bin/env bash
# SubagentStop (matcher "code-reviewer"): send the reviewer back once if its findings have no path:line references.
# stop_hook_active is true when it has already been sent back, so this cannot loop.
set -uo pipefail
input=$(cat)
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = true ] && exit 0
msg=$(jq -r '.last_assistant_message // ""' <<<"$input")
grep -qi 'no findings' <<<"$msg" && exit 0
grep -Eq '[A-Za-z0-9_./-]+\.[A-Za-z]+:[0-9]+' <<<"$msg" && exit 0
jq -n '{decision: "block", reason: "Give each finding as path:line (for example src/db.ts:14), so it can be checked."}'
exit 0
