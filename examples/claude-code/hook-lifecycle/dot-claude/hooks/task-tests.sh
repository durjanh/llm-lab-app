#!/usr/bin/env bash
# TaskCompleted: a task is only done when the tests pass. Exit code 2 keeps it open, with the failure as the reason.
set -uo pipefail
cat >/dev/null
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
# With no TEST_CMD, run npm test only when package.json has a test script; otherwise every task would stay open.
if [ -z "${TEST_CMD:-}" ] && ! jq -e '.scripts.test' package.json >/dev/null 2>&1; then exit 0; fi
if ! out=$(bash -c "${TEST_CMD:-npm test --silent}" 2>&1); then
  { echo "The tests are failing, so the task stays open:"; tail -15 <<<"$out"; } >&2
  exit 2
fi
exit 0
