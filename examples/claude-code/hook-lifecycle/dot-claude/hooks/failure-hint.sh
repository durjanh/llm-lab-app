#!/usr/bin/env bash
# PostToolUseFailure (matcher "WebFetch"): a fetch failed. If it was the public npm registry, tell Claude about the
# internal mirror. This event cannot block; its additionalContext reaches Claude with the failure.
set -uo pipefail
url=$(jq -r '.tool_input.url // empty')
case "$url" in
  *registry.npmjs.org*)
    jq -n --arg m "${NPM_MIRROR:-https://npm-mirror.internal}" \
      '{hookSpecificOutput: {hookEventName: "PostToolUseFailure",
        additionalContext: "The public npm registry is blocked from this network. Use \($m) instead."}}' ;;
esac
exit 0
