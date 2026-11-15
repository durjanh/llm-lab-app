#!/usr/bin/env bash
# PreCompact: whatever this prints becomes extra instructions for the summary, so the things that matter survive it.
set -uo pipefail
cat >/dev/null
echo "In the summary, keep: the full list of files changed, every failing test with its error message, and each decision made with its reason."
changed=$(git -C "${CLAUDE_PROJECT_DIR:-.}" diff --name-only HEAD 2>/dev/null | head -40)
[ -n "$changed" ] && { echo "Files changed so far:"; echo "$changed"; }
exit 0
