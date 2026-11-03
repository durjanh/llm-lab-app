# The five tasks

Every SDK folder implements the same five tasks with the same tools, data and prompts (all in `shared/`), so the code can be compared line for line. Each script prints its answer and a `PASS` or `FAIL` line from `shared.checks`.

| # | Script | What it shows | Check |
|---|---|---|---|
| 1 | `01_structured.py` | One model call returning a typed object (`shared.tasks.Triage`) for `shared.tasks.COMPLAINT` | category `repairs`, urgency `high` |
| 2 | `02_tools.py` | Function tools: `search_engagements` and `get_engagement` from `shared.engagements`, the SDK runs the tool loop, answering `shared.tasks.QUESTION` | answer names ENG-101 and about 53% |
| 3 | `03_mcp.py` | The same question, but the tools come from the MCP server `examples/mcp/server.py` over stdio (`shared.config.MCP_COMMAND`), not from Python functions | same as 2 |
| 4 | `04_agent.py` | An autonomous agent working toward `shared.tasks.GOAL` over several steps, with the harness features: a step limit, a trace of every tool call, and **human approval before the write tool `log_risk` runs** (ask on the terminal; `--auto-approve` for unattended runs) | exactly one new risk, on ENG-107, medium, owner Eleni Papadakis (`shared.checks.agent_ok`) |
| 5 | `05_multi_agent.py` | The SDK's own multi-agent pattern (handoff, sequential crew, graph, group chat, workflow…): a researcher agent with the tools, then a writer agent that drafts `shared.tasks.UPDATE_BRIEF` | the update names Northgate and the budget used |

Rules for every implementation:
- Use the shared tools, prompts and models; don't change them per SDK.
- Azure OpenAI `gpt-5.4-mini` through Entra sign-in (`shared.config`), unless the SDK is a provider's own (the Claude SDK uses Claude).
- Keep each script short and idiomatic for its SDK: the point is to show how *that* SDK does it.
