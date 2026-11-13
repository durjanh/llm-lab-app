# Agent SDKs compared

The same five tasks in eleven Python SDKs, so you can read how each does structured output, tool calling, MCP, an autonomous agent with human approval, and multi-agent work.

- **[CHEATSHEET.md](CHEATSHEET.md)**: the comparison, concept by concept, with gotchas and which to choose.
- **[TASKS.md](TASKS.md)**: the five tasks and their checks.
- **[RESULTS.md](RESULTS.md)**: the last full run.
- `shared/`: the tools, data, prompts, checks and config every SDK uses. The tools and data are the engagement tracker from `examples/mcp`, so task 3 calls the same tools over MCP.
- One folder per SDK: `openai`, `openai-agents`, `claude`, `agent-framework`, `semantic-kernel`, `autogen`, `langchain`, `langgraph`, `crewai`, `strands`, `pydantic-ai`. Each has the five scripts, `requirements.txt` (exact versions) and `NOTES.md`. `agent-framework` also has `06_responses.py`, which compares Chat Completions with the Responses API under the same agent (`AF_API=responses` runs any of its tasks on Responses).

## Run

Each SDK has its own Python 3.12 environment, because several pin conflicting versions of the same packages (AutoGen needs the MCP SDK 1.x, others take 2.x).

```sh
cd examples/sdks/langgraph
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python 02_tools.py
.venv/bin/python 04_agent.py            # asks you before the agent writes; --auto-approve for unattended runs
```

All of them, writing RESULTS.md (failed runs' output goes to `logs/`):

```sh
python examples/sdks/run_all.py              # every folder that has a .venv
python examples/sdks/run_all.py claude crewai
```

Needs the lab's `.env` (`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENTS`; `ANTHROPIC_API_KEY` for the Claude, Strands and PydanticAI folders (those two run on `claude-haiku-5-5`)) and `az login`. The MCP server runs with the lab's own `.venv`. A full run of all 55 scripts takes about five minutes and costs well under a dollar.
