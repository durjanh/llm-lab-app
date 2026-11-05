# The coding agent on the Claude Agent SDK

`coding_agent_sdk.py` does what `python/19_coding_agent.py` does, on a copy of `python/coding_project`, but on the Claude Agent SDK. The SDK runs Claude Code itself: its CLI ships inside the `claude-agent-sdk` package. So the loop, the file tools, the shell, the context management and the sub-agents are Claude Code's own. The script only configures them and adds callbacks.

| What | How it is set |
|---|---|
| Built-in tools | `tools=["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite", "Task"]` (Task starts sub-agents) |
| Sub-agent | `agents={"explore": AgentDefinition(tools=["Read", "Glob", "Grep"], ...)}` |
| Permission mode | `permission_mode`: `default`, `acceptEdits`, `plan` or `bypassPermissions` |
| Allow and deny rules | `allowed_tools=["Bash(python -m unittest *)", ...]`, `disallowed_tools=["Bash(git push *)", ...]` |
| Asking a person | `can_use_tool`, called for whatever the rules and the mode leave open |
| Hooks | `PreToolUse` refuses `.env` and `.git`; `PostToolUse` compiles Python after an edit |
| Project instructions | `setting_sources=["project"]` loads the copy's `CLAUDE.md`, and nothing from your own `~/.claude` |
| Limits | `max_turns`, `max_budget_usd`; the result message reports turns and cost |
| Auto mode | `--mode auto`: `permission_mode="bypassPermissions"` with `sandbox={"enabled": True, "allowUnsandboxedCommands": False, "network": {"allowedDomains": ["pypi.org", ...]}}`, and a shorter deny list (`git push`, `ssh`, `sudo`) |
| Done means done | a `Stop` hook runs the tests when `git status` shows changes, and returns `{"decision": "block", "reason": ...}` while they fail, so Claude Code carries on (three times at most) |
| Your own tool | `mcp_servers={"lab": create_sdk_mcp_server("lab", tools=[screenshot])}`: renders a page in headless Chrome and returns a text block and an image block. It is called `mcp__lab__screenshot` and is on the allow list. Read already returns images itself |

A tool named whole in `allowed_tools` (`Read`, `Grep`) is approved before `can_use_tool` is asked. The SDK warns about that on every run; the script silences the warning, because reading needs no person.

## Run it

```sh
cd examples/claude-agent-sdk
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python coding_agent_sdk.py                         # fix the failing tests, asking before edits
.venv/bin/python coding_agent_sdk.py --task feature --mode acceptEdits
.venv/bin/python coding_agent_sdk.py --task cleanup --mode bypassPermissions   # deny rules still refuse
.venv/bin/python coding_agent_sdk.py --task page --mode acceptEdits            # builds a chart page, checks it by eye
.venv/bin/python coding_agent_sdk.py --task excel --mode auto                  # sandboxed, never asks
```

It reads `ANTHROPIC_API_KEY` from the environment or the lab's `.env`. Each run gets its own temporary `CLAUDE_CONFIG_DIR`, so your Claude Code settings, memory and sessions are not used or changed. Each copy of the project is its own git repository, and `GIT_CEILING_DIRECTORIES` stops git looking above it.

With `--json` it prints one JSON event per line and reads permission answers from stdin as `{"id": ..., "allow": true}`. That is how the lab backend runs it for the Coding agent page (`/coding-agent`), once this folder's `.venv` exists.

## Compared with the hand-built harness

On the fix task with Haiku, the hand-built harness took 4 to 6 turns and about $0.002; the SDK took 7 to 14 turns and about $0.005. Claude Code's system prompt and tool descriptions are far longer, and it tends to read more before it edits. In exchange you get its tools, prompts, checkpoints and compaction, which have had far more use than anything written for one project.
