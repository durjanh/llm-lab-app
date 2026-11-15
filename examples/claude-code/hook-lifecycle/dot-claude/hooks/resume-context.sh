#!/usr/bin/env bash
# SessionStart (matcher "resume"): tell Claude what changed in git since the session was last used. Plain standard
# output becomes context. seconds_since_last_response and prompt_cache_likely_expired need Claude Code 2.1.251 or later.
set -uo pipefail
input=$(cat)
secs=$(jq -r '.seconds_since_last_response // empty' <<<"$input")
expired=$(jq -r '.prompt_cache_likely_expired // false' <<<"$input")
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null && git rev-parse --git-dir >/dev/null 2>&1 || exit 0
[ -n "$secs" ] || exit 0
since=$(( $(date +%s) - ${secs%.*} ))
commits=$(git log --since="@$since" --oneline --all --no-merges 2>/dev/null | head -20)
if [ -n "$commits" ]; then
  echo "Since this session was last used ($(( ${secs%.*} / 60 )) minutes ago), these commits arrived:"
  echo "$commits"
fi
[ "$expired" = true ] && echo "The prompt cache has probably expired, so the first request will cost more."
exit 0
