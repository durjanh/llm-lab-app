#!/usr/bin/env bash
# Elicitation (matcher "tickets"): the tickets MCP server asks for input mid-call. If the only thing it asks for is a
# priority, answer P3 so no form appears. Anything else: no output, and you see the form.
set -uo pipefail
fields=$(jq -c '[.requested_schema.properties // {} | keys[]]')
if [ "$fields" = '["priority"]' ]; then
  jq -n '{hookSpecificOutput: {hookEventName: "Elicitation", action: "accept", content: {priority: "P3"}}}'
fi
exit 0
