#!/usr/bin/env bash
# WorktreeCreate: replaces Claude Code's own git worktree creation, so it must print the new folder's absolute path as
# its last line. It makes the same worktree git would (.claude/worktrees/<name>, branch worktree-<name>), then copies
# the git-ignored files listed in .worktreeinclude, which Claude Code does not process when this hook is used.
set -euo pipefail
name=$(jq -r '.name')
[[ "$name" =~ ^[A-Za-z0-9._-]+$ && "$name" != *..* ]] || { echo "Bad worktree name: $name" >&2; exit 1; }
root=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel)
dest="$root/.claude/worktrees/$name"
git -C "$root" worktree add -q -b "worktree-$name" "$dest" HEAD >&2
if [ -f "$root/.worktreeinclude" ]; then
  while IFS= read -r rel; do
    case "$rel" in '' | '#'* | /* | *..*) continue ;; esac
    [ -e "$root/$rel" ] || continue
    mkdir -p "$(dirname "$dest/$rel")" && cp -R "$root/$rel" "$dest/$rel"
  done <"$root/.worktreeinclude"
fi
echo "$dest"
