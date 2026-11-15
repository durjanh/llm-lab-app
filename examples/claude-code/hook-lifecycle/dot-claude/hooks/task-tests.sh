#!/usr/bin/env bash
# TaskCompleted: a task is only done when the tests pass. Exit code 2 keeps it open, with the failure as the reason.
set -uo pipefail
cat >/dev/null
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
if ! out=$(${TEST_CMD:-npm test --silent} 2>&1); then
  { echo "The tests are failing, so the task stays open:"; tail -15 <<<"$out"; } >&2
  exit 2
fi
exit 0
