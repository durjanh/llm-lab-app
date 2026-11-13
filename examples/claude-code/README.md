# Claude Code setup examples

Copyable examples for the Claude Code setup lab (`/claude-code`). They are stored under names Claude Code does not load, so they have no effect on this repository until you copy them into a project.

| Example here | Copy to | What it is |
|---|---|---|
| `CLAUDE.example.md` | `CLAUDE.md` at your project root | Project memory: commands and conventions |
| `dot-claude/rules/api.md` | `.claude/rules/api.md` | A rule that loads only when matching files are touched |
| `dot-claude/rules/testing.md` | `.claude/rules/testing.md` | A rule for test files wherever they sit, by glob pattern |
| `dot-claude/commands/fix-issue.md` | `.claude/commands/fix-issue.md` | A team slash command in the older single-file form: `/fix-issue 123` |
| `dot-claude/skills/map-codebase/` | `.claude/skills/map-codebase/` | A skill with `context: fork` and `agent: Explore`: it explores in its own context and returns a summary |
| `dot-claude/skills/summarize-changes/` | `.claude/skills/summarize-changes/` | A skill from the docs that summarises uncommitted changes |
| `dot-claude/skills/release/` | `.claude/skills/release/` | A side-effecting skill that only runs when you type `/release` |
| `dot-claude/agents/code-reviewer.md` | `.claude/agents/code-reviewer.md` | A read-only reviewer subagent |
| `dot-claude/settings.json` | `.claude/settings.json` | Hooks: block edits to protected files, format after edits |
| `dot-claude/hooks/protect-files.sh` | `.claude/hooks/protect-files.sh` | The script behind the blocking hook; run `chmod +x` on it |
| `my-first-plugin/` | anywhere | A minimal plugin; try it with `claude --plugin-dir ./my-first-plugin` |
| `ci/claude-review.yml` | `.github/workflows/claude-review.yml` | Reviews every pull request with `claude -p` |
| `ci/review.sh`, `ci/review-schema.json` | `.github/claude/` | The review: print mode with `--output-format json` and `--json-schema`, findings read from `structured_output`, earlier findings passed in so re-runs report only new or still-open issues, then one pull request comment |

The CI review needs an `ANTHROPIC_API_KEY` repository secret, and `review.sh` uses `gh` and `jq`, which GitHub's hosted runners already have. It allows only read-only tools and `git diff`, and refuses everything else with `--permission-mode dontAsk`.

Hooks run shell commands with your full user permissions. Read every hook before you add it. The formatting hook needs `jq` and Prettier installed.

The formats follow the Claude Code documentation at code.claude.com as of October 2026; the rules, commands, forked skill and CI files were checked on 13 November 2026. Claude Code changes often, so check the docs if something does not load.
