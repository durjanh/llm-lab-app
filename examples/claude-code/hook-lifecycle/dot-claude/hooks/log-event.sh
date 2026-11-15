#!/usr/bin/env bash
# Any event: append one line to .claude/hook-log.jsonl, so trace.py can show the order the events really fired in.
# Registered with "async": true, so it never slows Claude down. Not used on WorktreeCreate (that hook must print a
# path) or MessageDisplay (it runs for every piece of text shown).
set -uo pipefail
log="${CLAUDE_PROJECT_DIR:-.}/.claude/hook-log.jsonl"
mkdir -p "$(dirname "$log")"
jq -c '{t: now, event: .hook_event_name, session: .session_id,
  detail: (.tool_name // .source // .trigger // .reason // .notification_type // .agent_type // .error
           // .load_reason // .command_name // .to_model // .task_subject // .file_path // .new_cwd // null)}' >>"$log"
exit 0
