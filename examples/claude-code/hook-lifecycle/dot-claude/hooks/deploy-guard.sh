#!/usr/bin/env bash
# UserPromptExpansion (matcher "deploy"): /deploy only from main. A PreToolUse hook on the Skill tool would miss this,
# because it only sees skills Claude chooses to run, not commands you type.
set -uo pipefail
cat >/dev/null
branch=$(git -C "${CLAUDE_PROJECT_DIR:-.}" branch --show-current 2>/dev/null)
[ "$branch" = main ] && exit 0
jq -n --arg b "${branch:-an unknown branch}" '{decision: "block", reason: "Deploys run from main only. You are on \($b)."}'
exit 0
