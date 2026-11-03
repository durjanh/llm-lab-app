# Claude Code setup examples

Copyable examples for the Claude Code setup lab (`/claude-code`). They are stored under names Claude Code does not load, so they have no effect on this repository until you copy them into a project.

| Example here | Copy to | What it is |
|---|---|---|
| `CLAUDE.example.md` | `CLAUDE.md` at your project root | Project memory: commands and conventions |
| `dot-claude/rules/api.md` | `.claude/rules/api.md` | A rule that loads only when matching files are touched |
| `dot-claude/skills/summarize-changes/` | `.claude/skills/summarize-changes/` | A skill from the docs that summarises uncommitted changes |
| `dot-claude/skills/release/` | `.claude/skills/release/` | A side-effecting skill that only runs when you type `/release` |
| `dot-claude/agents/code-reviewer.md` | `.claude/agents/code-reviewer.md` | A read-only reviewer subagent |
| `dot-claude/settings.json` | `.claude/settings.json` | Hooks: block edits to protected files, format after edits |
| `dot-claude/hooks/protect-files.sh` | `.claude/hooks/protect-files.sh` | The script behind the blocking hook; run `chmod +x` on it |
| `my-first-plugin/` | anywhere | A minimal plugin; try it with `claude --plugin-dir ./my-first-plugin` |

Hooks run shell commands with your full user permissions. Read every hook before you add it. The formatting hook needs `jq` and Prettier installed.

The formats follow the Claude Code documentation at code.claude.com as of October 2026. Claude Code changes often, so check the docs if something does not load.
