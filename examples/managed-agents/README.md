# Anthropic-hosted agents (Claude Managed Agents)

Claude Managed Agents (a beta) is an agent you configure and Anthropic runs. You store an **agent** (model, system prompt, tools), then start **sessions** of it. Each session gets its own container; the agent loop runs on Anthropic's side and uses bash, file and code tools inside that container. You send messages and read an event stream. There is no loop code, no sandbox to build and no state file to keep.

`run_agent.py` is the whole flow: create an environment, create an agent, start a session, send a task, stream events until the session is idle, then read the usage and download the files the agent wrote. It is compile-checked only (`python -m py_compile`) and has not been run, because Managed Agents is a paid beta. Run it with `ANTHROPIC_API_KEY` set.

```sh
pip install -r requirements.txt
python run_agent.py
```

Create the agent and environment once and reuse them (`MANAGED_AGENT_ID`, `MANAGED_ENV_ID`); a session is what you create for each run. Anthropic recommends keeping agent and environment definitions as files and syncing them with the `ant apply` command, so the control plane (create, update) lives in version control and your code only starts sessions.

## The objects

| Object | What it is | Lifetime |
|---|---|---|
| Environment | A container template: packages, networking policy (`limited` is deny by default) | Reusable |
| Agent | Stored, versioned config: `model`, `system`, `tools` (the `agent_toolset_20260401` built-ins, your own custom tools, MCP servers) | Create once |
| Session | One run, pinned to an agent version, in its own container; holds the event history | Per run |
| Events | `user.message`, `agent.message`, `agent.tool_use`, `session.status_idle` and more, as a server-sent event stream or polled with `events.list` | Per session |

Tool calls can be `always_allow`, `always_ask` or `auto`. A call that pauses arrives as an event with `evaluated_permission == "ask"`, and you answer with `user.tool_confirmation` (`allow` or `deny`). That is the same human-approval gate as task 4 in `examples/sdks`, done by the platform. Custom tools run on your side: the agent emits `agent.custom_tool_use`, you run it and send `user.custom_tool_result`.

Other parts of the platform, not used in the script: outcomes (a grader checks the result against your rubric and the agent revises), multi-agent workflows, memory stores across sessions, vaults for credentials, scheduled deployments and self-hosted sandboxes (the loop stays on Anthropic's side, tools run on your machines).

## Self-hosted, Anthropic-hosted, Foundry-hosted

| | Self-hosted loop (`examples/sdks/claude`, the lab's coding agent) | Claude Agent SDK | Anthropic-hosted: Managed Agents | Foundry hosted agent (`examples/medassist/hosted`) |
|---|---|---|---|---|
| Who writes the agent loop | You (or the SDK's tool runner) | The SDK, which is Claude Code's loop as a library | Anthropic | You: your code is the agent |
| Where the loop runs | Your process | Your process or container | Anthropic's orchestration layer | A container Foundry runs for you |
| Where tools run | Your code, in the process; for bash the lab uses an OS sandbox or Docker | Your machine, with built-in file and shell tools | A per-session container Anthropic hosts (or one you host) | In your container |
| State and history | You keep it | Session files on your disk | Stored by Anthropic as the session | Yours (the agent keeps it), Foundry holds conversations |
| Model | Any Claude model, or GPT and local models in this lab | Claude | Claude only | Any model in Foundry, here a GPT deployment |
| Scale and ops | Yours | Yours | Anthropic scales sessions; you pay for tokens and session time | Foundry scales the container behind a stable endpoint |
| Sign-in | API key; Entra only on Foundry | API key or cloud provider | API key, billed to the organisation | Entra ID, Azure RBAC |
| Control | Total: every step, approval and trace is your code | High: hooks, permissions | Medium: events, permissions, outcomes; the loop is a black box you configure | Total: it is your code |
| Reach for it when | You need the loop, data residency or non-Claude models | A coding or file agent on your own infrastructure | A long-running or scheduled Claude agent without building infrastructure | The agent must live in your Azure tenant under your identity and network rules |

Managed Agents is not available through Bedrock, Vertex or Foundry (see `../claude-platforms/README.md`): it is a first-party feature. A Foundry hosted agent is a different product that happens to share the word "hosted": Foundry runs your code, whereas Managed Agents runs Anthropic's loop.
