---
name: check
description: Runs the tests and type checks that cover the files changed in llm-lab-app, then reports what failed. Use after making changes, before a commit, or when asked to check, test or verify the work.
---

## Changed files

!`git status --short`

## Instructions

Run only the checks that cover the changed files above. Run them all from the repo root with `.venv/bin/python`, so the virtual environment does not need to be active. If nothing has changed, say so and run nothing, unless the user asked for a full check.

| Changed paths | Check |
| --- | --- |
| `backend/`, `python/` (except `coding_project/`), `examples/medassist/`, `examples/aftercare/` | `.venv/bin/python -m pytest backend -q` |
| `frontend/src/` | `cd frontend && npm run typecheck` |
| `frontend/vite.config.*`, `frontend/package.json`, or the user asks for a build | `cd frontend && npm run build` (this rewrites `frontend/dist`) |
| `dotnet/` | `cd dotnet && dotnet test` |
| `examples/medassist/clinic.py` | `pytest backend` and `dotnet test`, because a .NET test pins the database to Python's |
| `examples/agent-framework/` | `.venv/bin/python -m pytest examples/agent-framework -q` |
| `examples/mcp/` | `.venv/bin/python -m pytest examples/mcp -q` |

Rules:

- Files named `README.md` or `CLAUDE.md`, and anything under `.claude/`, need no check. They are docs and instructions, not code, so a change to `dotnet/CLAUDE.md` does not run `dotnet test`.
- Run independent checks in parallel.
- Never run or fix the tests in `python/coding_project/` or in copies under `generated/`. Their failures are deliberate practice material.
- The backend tests use a fake Claude client, so they cost nothing and need no key. Do not run anything that makes paid model calls.
- If `.venv` or `frontend/node_modules` is missing, say so and skip that check. Do not install anything.
- Do not fix failures unless the user asks. Report them.

## Report

Start with one line per check, giving its result: passed, failed, or skipped and why. For each failure, give the failing test or file and line, and the relevant part of the error, not the whole log. If the failure plainly comes from the changed code, say which change caused it.
