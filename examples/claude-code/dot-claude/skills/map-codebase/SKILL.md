---
description: Maps an unfamiliar part of the codebase and reports its entry points, data flow and tests. Use before changing code you have not read.
argument-hint: "[folder or feature]"
context: fork
agent: Explore
---

Map $ARGUMENTS.

1. Find the entry points with Grep, then follow the imports with Read. Do not read every file up front.
2. List the main files, one line each on what they do.
3. Trace one request or call from start to finish.
4. Name the tests that cover this area, and the gaps.

Report in under 40 lines. Change nothing.
