#!/usr/bin/env bash
# PreToolUse hook: block edits to protected files.
# Claude Code sends the tool call as JSON on stdin. Exit code 2 blocks the call,
# and whatever is written to stderr goes back to Claude as the reason.
set -euo pipefail

file_path=$(jq -r '.tool_input.file_path // empty')

case "$file_path" in
  *.env | */package-lock.json | */.git/*)
    echo "Blocked: $file_path is protected. Ask the user to change it themselves." >&2
    exit 2
    ;;
esac

exit 0
