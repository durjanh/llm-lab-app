#!/usr/bin/env bash
# TaskCreated: every task subject starts with a ticket number such as PAY-412. Exit code 2 deletes the task and the
# reason goes back to Claude.
set -uo pipefail
subject=$(jq -r '.task_subject // ""')
if [[ ! "$subject" =~ ^[A-Z][A-Z0-9]+-[0-9]+[[:space:]] ]]; then
  echo "Task subjects need a ticket number first, such as \"PAY-412 $subject\"." >&2
  exit 2
fi
exit 0
