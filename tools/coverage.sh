#!/usr/bin/env bash
# Runs every test with coverage, then checks that every line changed since BASE is covered by a test: 100% of the
# change, not of the whole repo (older code is brought up to that as it is touched). Uncommitted and new files count.
#
#   ./tools/coverage.sh                  backend and frontend, changes against origin/main
#   BASE=HEAD ./tools/coverage.sh        only the changes not yet committed
#   ./tools/coverage.sh --report         also print each changed file's uncovered lines
#
# Reports go to generated/coverage/ (ignored by git). It costs nothing: the tests use fake models.
set -euo pipefail
cd "$(dirname "$0")/.."
. tools/lib.sh
case "${1:-}" in -h|--help) usage; exit 0 ;; esac  # help works before anything is set up
need_venv

BASE="${BASE:-origin/main}"
OUT=generated/coverage
mkdir -p "$OUT"
export COVERAGE_FILE="$OUT/.coverage"  # not in the repo root

echo "Backend tests, with coverage..."
.venv/bin/python -m pytest backend -q -p no:cacheprovider --cov=backend/app --cov=python --cov=tools \
  --cov-report="xml:$OUT/backend.xml" --cov-report= >/dev/null

echo "Frontend tests, with coverage..."
(cd frontend && npx vitest run --coverage.enabled --coverage.reporter=cobertura \
  --coverage.reportsDirectory="../$OUT/frontend" --coverage.include='src/**' >/dev/null)

echo "Lines changed since $BASE, and whether each is covered:"
args=(--compare-branch="$BASE" --include-untracked --fail-under=100)
[ "${1:-}" = "--report" ] && args+=(--show-uncovered)
.venv/bin/diff-cover "$OUT/backend.xml" "$OUT/frontend/cobertura-coverage.xml" "${args[@]}"
