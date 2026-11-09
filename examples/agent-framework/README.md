# The council complaint flow in Microsoft Agent Framework, with DevUI

Lab 25 (`/casework`) runs a council's housing-complaint flow with orchestration written by hand. This folder runs **the same flow** in Microsoft Agent Framework (Python), so the two can be compared: the same prompts, sample data, tools, Azure AI Search index and code rule check, imported from `backend/app/services/casework.py`. Only the orchestration differs.

| | Lab 25 (hand-written) | This example (Agent Framework) |
|---|---|---|
| Model calls | OpenAI SDK, chat completions | `Agent` on `OpenAIChatCompletionClient` (Azure endpoint, Entra credential) |
| Structured outputs | JSON schemas | pydantic models via `response_format`, read from `response.value` |
| Tools | a hand-written function-calling loop | `@tool` functions; the framework runs the loop |
| Flow | a Python generator | `Executor` steps in a `WorkflowBuilder` graph, with a conditional loop edge for the one revision |
| Human approval | a REST endpoint and a page | `ctx.request_info(...)` pauses the workflow; `@response_handler` resumes it. DevUI shows the form |
| Watching it | the animated diagram | DevUI: the graph, an execution timeline, events and OpenTelemetry traces |

## Run it

Needs the same Azure setup as Lab 25 (`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENTS`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`, `AZURE_SEARCH_ENDPOINT` in `.env`, and `az login`). Open Lab 25 once first so the search index exists.

```sh
pip install -r examples/agent-framework/requirements.txt
python examples/agent-framework/casework_workflow.py          # DevUI at http://127.0.0.1:8090
```

In DevUI, open the arrow on **Run Workflow** → **Configure Inputs**, choose a case, and run it. Watch the steps complete on the graph; the checks step may run twice (the revision). When it reaches the caseworker, DevUI shows **Workflow is waiting for your input** with the draft and a form: choose approve or reject, give your name, and submit. The **Traces** tab shows every model and tool call.

Without the UI, one case end to end, approving from the command line:

```sh
python examples/agent-framework/casework_workflow.py --case C-301 --approve-as "Sam Patel"
```

The audit log for these runs is `casework/agent-framework-audit.jsonl` (hash-chained, ignored by git). DevUI binds to 127.0.0.1 with its token check switched off; keep it on your machine.

Agent Framework's DevUI is a beta (`agent-framework-devui` 1.0.0b261022), and its Azure AI and search integrations are separate packages not used here.

## Microsoft's Foundry agent sample, alongside

`foundry_weather/` is Microsoft's DevUI sample "Azure AI Weather Agent", unchanged (MIT licence, copyright Microsoft), from `python/samples/02-agents/devui/agent_foundry` in [microsoft/agent-framework](https://github.com/microsoft/agent-framework). It calls a model through a **Foundry project** (`FoundryChatClient`) rather than the Azure OpenAI endpoint, with two mock weather tools. It reads two settings from `.env`:

```sh
FOUNDRY_PROJECT_ENDPOINT=https://ai-llm-lab-0eevth.services.ai.azure.com/api/projects/llm-lab
FOUNDRY_MODEL=gpt-5.4-mini
```

Calls through a Foundry project need the **Foundry User** role on the Foundry resource (it was called Azure AI User); the Azure OpenAI roles are not enough, and a call without it fails with 403.

Run both in one DevUI, and switch between them with the selector at the top:

```sh
python examples/agent-framework/serve_all.py      # http://127.0.0.1:8090, with MedAssist too (one agent per patient); DEVUI_PORT for another port
```

DevUI's **Browse Gallery** lists four Microsoft samples, but its Download links point at old paths in the repository and return 404: the folders were renamed on `main` (`foundry_agent` is now `agent_foundry`, `spam_workflow` is now `workflow_spam`, and so on). Get them from the repository's `python/samples/02-agents/devui/` folder instead. The sample marks its tools `approval_mode="never_require"` for brevity; Microsoft's own comment says to require approval in production.

## Every workflow type

`workflows/` has one short, runnable file for each type of workflow in Microsoft's guidance, all on Azure OpenAI with Entra sign-in. The `/workflows` page runs these same files.

| File | Type |
|---|---|
| `01_sequential.py` | Sequential |
| `02_concurrent.py` | Concurrent, with a chair that settles disagreement |
| `03_fan_out_fan_in_edges.py` | Fan-out and fan-in edges wired by hand; one branch is plain code |
| `04_handoff.py` | Handoff, with a tool and turn limits |
| `05_group_chat.py` | Group chat with a manager agent |
| `06_maker_checker.py` | Maker-checker loop, with an iteration cap and a fallback to a person |
| `07_magentic.py` | Magentic, with its task and progress ledgers |
| `08_orchestrator_workers.py` | Orchestrator and workers (subagents, as agents used as tools) |
| `09_routing.py` | Switch-case and multi-selection edges |
| `10_plan_approve_run.py` | Plan, a real pause for a person, then run |
| `11_checkpoint_resume.py` | A crash, then a resume that repeats no finished work |
| `12_sub_workflow.py` | A workflow used as one step of another |
| `13_declarative.py`, `returns_desk.yaml` | The workflow as a YAML file, with Power Fx conditions |

```sh
cd examples/agent-framework/workflows
python 02_concurrent.py                 # add --task "..." for your own task
python 10_plan_approve_run.py           # stops and asks you; --yes answers for you
python 02_concurrent.py --diagram       # the graph as Mermaid
python record.py                        # re-record the runs the page replays (a few cents)
```

`13_declarative.py` needs its own environment, because the Power Fx engine isn't published for Python 3.14 and needs a .NET runtime:

```sh
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-declarative.txt
.venv/bin/python 13_declarative.py
```
