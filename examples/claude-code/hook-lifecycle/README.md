# The hook lifecycle, wired up

Working hooks for the advanced scenarios on `/claude-code#lifecycle` and in chapter 7 of `/claude-code-inside`, plus a logger on every event so you can see the lifecycle chart happen in a real session.

## Try it

1. Copy `dot-claude/` into a project as `.claude/` (merge with any `settings.json` you already have), and make the scripts executable: `chmod +x .claude/hooks/*.sh`.
2. Use Claude Code in that project for a while: ask for an edit, run tests, `/compact`, `/exit`.
3. Run `python3 trace.py` in the project. It prints every event that fired, in order, indented by where it sits on the chart: session, then turn, then the agentic loop.

Each script's first lines say what it does and why. Several read settings from the environment, so you can try them without changing the code: `TYPECHECK_CMD`, `TEST_CMD`, `NPM_MIRROR`, `REVIEW_SCOPE`, `TEAM_FILE`, `OPEN_TASKS_FILE`, `MAX_CACHE_USD` and `NOTIFY_CMD`.

| Event | Script | What it does |
|---|---|---|
| All but WorktreeCreate and MessageDisplay | `log-event.sh` | One line per event to `.claude/hook-log.jsonl`, in the background (`async`) |
| Setup (`init`) | `setup-init.sh` | Installs dependencies once, for `claude --init-only` |
| SessionStart (`resume`) | `resume-context.sh` | Adds the commits since the session was last used |
| UserPromptExpansion (`deploy`) | `deploy-guard.sh` | Blocks `/deploy` away from `main` |
| PermissionRequest (`Bash`) | `approve-readonly.sh` | Allows read-only git; denies a download piped into a shell; otherwise you see the dialog |
| PermissionDenied | `denied-audit.sh` | Records what auto mode refused in `.claude/denied.jsonl` |
| Elicitation, ElicitationResult (`tickets`) | `elicitation-defaults.sh`, `elicitation-check.sh` | Answers a lone priority question; declines an owner who is not on the team list |
| PostToolUseFailure (`WebFetch`) | `failure-hint.sh` | Points Claude at an internal npm mirror |
| PostToolBatch | `batch-typecheck.sh` | One type check per batch of edits, errors sent back as context |
| SubagentStart, SubagentStop (`code-reviewer`) | `review-scope.sh`, `review-needs-refs.sh` | Tells the reviewer its scope; sends it back once if findings lack `path:line` |
| TaskCreated, TaskCompleted | `task-ticket.sh`, `task-tests.sh` | Needs a ticket number in each task; keeps a task open while tests fail |
| StopFailure | `stop-failure-notify.sh` | A desktop notification and the terminal bell |
| TeammateIdle | `teammate-idle.sh` | Keeps a teammate working while `.claude/open-tasks.txt` has lines |
| PreCompact | `pre-compact.sh` | Tells the summary to keep changed files, failing tests and decisions |
| ConfigChange (project and local settings) | `config-guard.sh` | Blocks a change that turns the project hooks off |
| PreModelSwitch | `model-switch-guard.sh` | Asks first when a switch would throw away a warm prompt cache |
| FileChanged (`.envrc`), CwdChanged | `envrc-reload.sh` | Loads plain `export` lines into the session; never runs the file |
| WorktreeCreate, WorktreeRemove | `worktree-create.sh`, `worktree-remove.sh` | The worktree git would make, plus the ignored files listed in `.worktreeinclude` |
| MessageDisplay | `mask-secrets.sh` | Masks API keys on screen only |

## Test

`.venv/bin/python -m pytest examples/claude-code/hook-lifecycle -q` from the repo root feeds each script the JSON its event sends and checks the exit code, output and files. It needs bash, jq and git, not Claude Code.

## Before you use these for real

- Hooks run with your full user permissions. Read each script before you copy it.
- `WorktreeCreate` replaces Claude Code's own worktree creation: if the script fails, no worktree is made. Leave it out unless you want the `.worktreeinclude` copying.
- `TaskCompleted`, `PostToolBatch` and `Setup` run real commands (`npm test`, `npx tsc`, `npm ci`). Set the `*_CMD` variables to match your project.
- `SessionStart`'s resume fields need Claude Code 2.1.251 or later.

The event names, inputs and outputs follow the hooks reference at code.claude.com/docs/en/hooks, checked on 13 November 2026.
