#!/usr/bin/env bash
# WorktreeRemove: remove a worktree that worktree-create.sh made, and nothing outside .claude/worktrees.
set -euo pipefail
path=$(jq -r '.worktree_path')
root=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel)
case "$path" in "$root"/.claude/worktrees/*) ;; *) echo "Not a hook-made worktree: $path" >&2; exit 1 ;; esac
case "$path" in *..*) echo "Refusing a path with ..: $path" >&2; exit 1 ;; esac
git -C "$root" worktree remove --force "$path"
