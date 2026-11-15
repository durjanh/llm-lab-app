#!/usr/bin/env bash
# ElicitationResult (matcher "tickets"): you answered the server's form; check the answer before it is sent. An owner
# who is not on the team list is declined (exit code 2 turns the answer into a decline).
set -uo pipefail
input=$(cat)
[ "$(jq -r '.action' <<<"$input")" = accept ] || exit 0
owner=$(jq -r '.content.owner // empty' <<<"$input")
[ -n "$owner" ] || exit 0
team="${TEAM_FILE:-${CLAUDE_PROJECT_DIR:-.}/.claude/team.txt}"
if [ -f "$team" ] && ! grep -qx -- "$owner" "$team"; then
  echo "\"$owner\" is not on the team list in $team, so the ticket was not assigned." >&2
  exit 2
fi
exit 0
