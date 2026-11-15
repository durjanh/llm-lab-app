#!/usr/bin/env bash
# MessageDisplay: mask API keys on screen, say during a demonstration. Only the screen changes: Claude and the
# transcript keep the original text. It runs for every piece of text shown, so it must be quick.
set -uo pipefail
jq -c '(.delta // "") as $d
  | ($d | gsub("sk-ant-[A-Za-z0-9_-]+"; "sk-ant-…") | gsub("AKIA[0-9A-Z]{16}"; "AKIA…")) as $m
  | if $m != $d then {hookSpecificOutput: {hookEventName: "MessageDisplay", displayContent: $m}} else empty end'
exit 0
