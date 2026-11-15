#!/usr/bin/env bash
# TeammateIdle (agent teams): keep a teammate working while open tasks remain. The list is your own, such as a file
# your planner writes, one task a line. Exit code 2 sends the teammate back with the reason.
set -uo pipefail
cat >/dev/null
open="${OPEN_TASKS_FILE:-${CLAUDE_PROJECT_DIR:-.}/.claude/open-tasks.txt}"
[ -s "$open" ] || exit 0
n=$(grep -c . "$open")
{ echo "$n tasks are still open. Take the next one:"; head -5 "$open"; } >&2
exit 2
