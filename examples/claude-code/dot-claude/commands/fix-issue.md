---
description: Fix a GitHub issue by number
argument-hint: "[issue-number]"
allowed-tools: Bash(gh issue view *), Bash(npm test *)
---

Fix issue #$ARGUMENTS.

1. Read it with `gh issue view $ARGUMENTS`.
2. Find the code involved, and write a failing test that shows the bug.
3. Fix it, run `npm test`, and summarise the change in three lines.
