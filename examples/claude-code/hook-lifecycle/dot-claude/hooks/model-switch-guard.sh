#!/usr/bin/env bash
# PreModelSwitch: ask before a switch that throws away a warm prompt cache costing more than MAX_CACHE_USD to rebuild.
# "ask" prompts only in an interactive /model; elsewhere it counts as a refusal.
set -uo pipefail
input=$(cat)
warm=$(jq -r '.prompt_cache_warm // false' <<<"$input")
usd=$(jq -r '.estimated_cache_write_usd // 0' <<<"$input")
limit="${MAX_CACHE_USD:-0.50}"
if [ "$warm" = true ] && awk -v u="$usd" -v l="$limit" 'BEGIN { exit !(u > l) }'; then
  jq -n --argjson u "$usd" --arg to "$(jq -r '.to_model' <<<"$input")" \
    '{hookSpecificOutput: {hookEventName: "PreModelSwitch", permissionDecision: "ask",
      permissionDecisionReason: "Switching to \($to) now rewrites a warm prompt cache, about $\($u). Switch anyway?"}}'
fi
exit 0
