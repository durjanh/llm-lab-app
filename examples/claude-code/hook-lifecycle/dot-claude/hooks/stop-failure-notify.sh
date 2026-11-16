#!/usr/bin/env bash
# StopFailure: the turn ended on an API error (rate_limit, overloaded, billing_error and others). It cannot block or
# retry, so tell someone. Claude Code only uses terminalSequence from the output: here, the terminal bell.
set -uo pipefail
input=$(cat)
err=$(jq -r '.error // "unknown"' <<<"$input")
msg="Claude Code stopped: $err"
if [ -n "${NOTIFY_CMD:-}" ]; then bash -c "$NOTIFY_CMD" notify "$msg" # the message is $1
elif command -v osascript >/dev/null; then osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Claude Code"' -e 'end run' "$msg" >/dev/null 2>&1
elif command -v notify-send >/dev/null; then notify-send "Claude Code" "$msg"
fi
jq -n '{terminalSequence: "\u0007"}'
exit 0
