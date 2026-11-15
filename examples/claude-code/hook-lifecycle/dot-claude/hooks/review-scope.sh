#!/usr/bin/env bash
# SubagentStart (matcher "code-reviewer"): add to the reviewer's starting context what to review and how to report.
set -uo pipefail
cat >/dev/null
scope="${REVIEW_SCOPE:-the files changed on this branch (git diff main...HEAD)}"
jq -n --arg s "$scope" '{hookSpecificOutput: {hookEventName: "SubagentStart",
  additionalContext: "Review only \($s). Report each finding as path:line, then the problem and the fix. If there is nothing to report, say No findings."}}'
exit 0
