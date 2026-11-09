# MedAssist in .NET (C#)

MedAssist, the patient portal agent from `examples/medassist/`, in C# on .NET 10, built in separate layers:
- an **ASP.NET Core API** that the lab's React page can call instead of the Python backend;
- a **command line**;
- **two engines**: the Foundry prompt agent with our own tool loop (as `medassist.py`), and Microsoft Agent Framework (as `medassist_af.py`).

## The layers

```
frontend (React)            pages/medassist/MedAssistPage.tsx -> services/medassistService.ts -> services/apiClient.ts
        │  HTTP, /api/medassist/*  (Vite forwards it here when LLM_LAB_MEDASSIST_API is set)
        ▼
MedAssist.Api               controllers: parse, call a service, map to the page's JSON
MedAssist.Cli               commands: the same services, from a terminal
        │
        ▼
MedAssist.Application       the service layer: ChatService, PracticeService, ScenarioRunner, SpendTracker
        │   through interfaces only
        ├──────────────► MedAssist.Domain       the rules (PatientSession), the tools, the repository interfaces
        │                    ▲ implements
        ├──────────────► MedAssist.Data         the database layer: SQLite repositories
        │
        └──────────────► MedAssist.Integrations.Foundry   the external API layer: Foundry gateways and both engines
```

Each layer knows only the one below it, through interfaces:
- **The page** gets its data from its own service (`medassistService.ts`). That service calls the API.
- **The controllers** call the services, and nothing else.
- **The services** reach the database through repository interfaces (`IPracticeRepository`, `IPracticeStore`), and Foundry through gateway interfaces (`IMedAssistEngine`, `IKnowledgeBase`, `IAgentCatalog`). The layers below implement them.
- **The domain** references no package at all: no database, no web, no AI SDK.

| Project | Layer | Depends on |
|---|---|---|
| `MedAssist.Domain` | Rules, tools, ports | nothing |
| `MedAssist.Data` | Database (SQLite) | Domain |
| `MedAssist.Application` | Services | Domain |
| `MedAssist.Integrations.Foundry` | External APIs (Foundry, both engines) | Application |
| `MedAssist.Api` | Web (controllers) | Application, Data and Integrations, wired in `Program.cs` only |
| `MedAssist.Cli` | Command line | the same, wired in `Program.cs` only |

## Design

- **Dependency inversion.** The rules depend on `IPracticeRepository`, `INotifier` and `TimeProvider`, never on SQLite or the clock. The services depend on ports, never on Foundry. Only the two `Program.cs` files, the composition roots, know which implementation is used.
- **Strategy:**
  - `IMedAssistEngine` has two implementations, `PromptAgentEngine` and `AgentFrameworkEngine`. `MedAssist:Engine` in `appsettings.json` chooses one; they're registered as keyed services.
  - Each clinic tool is its own `IClinicTool`, so adding a tool doesn't change the others or either loop.
- **Template Method:** `ClinicTool<TRequest>` reads the model's arguments into a typed request (`BookAppointmentRequest`), then runs the tool. Bad arguments become a `ToolError` the model can read.
- **Registry:** `ClinicToolbox` finds a tool by name. Both engines call tools through it.
- **Adapter:**
  - `FoundryKnowledgeBase`, `FoundryAgentCatalog` and `FoundryPromptAgentConversations` adapt Foundry's SDK to the ports;
  - `ClinicFunction` adapts a clinic tool to Agent Framework's `AIFunction`;
  - `SqlitePracticeRepository` adapts SQLite.
- **Command:** each CLI verb is an `ICommand`, and `CommandRouter` dispatches to it.
- **Observer:** `IStepObserver` and `IScenarioListener` hear each tool step and test result. The CLI prints them; the API needs none.
- **Chain of Responsibility:**
  - each layer has an `IFailureClassifier` for its own exceptions;
  - `FailureReporter` asks them in turn;
  - the API writes the result as `{"error": {"type", "message"}}` with a status;
  - the CLI prints the message.
- **Null Object:** `NullNotifier` stands in for "no real texts", and `NullStepObserver` for "nobody listening".
- **Typed results:** each tool outcome is a record (`AppointmentBooked`, `ConfirmCancel`, `FreeSlots`, `ToolError`…). `ToJson()` writes the same snake_case JSON the Python version sends the model.
- **Options pattern:**
  - `MedAssistOptions`, `FoundryOptions` and `PricingOptions` are bound from `appsettings.json` and validated by `IValidateOptions` classes;
  - relative paths are resolved by `IPostConfigureOptions`;
  - Foundry's settings are read only when Foundry is first called, so `records` and `reset` work with no Azure settings.

## Settings

Settings come from `appsettings.json`, then your own values, then the environment. Each source overrides the one before.

- **`appsettings.json`** (committed) in `src/MedAssist.Api` and `src/MedAssist.Cli` has every setting with its default.
- **`dotnet/appsettings.Local.json`** (git-ignored) holds your own values. Both programs read it. Start from `appsettings.Local.example.json`:
  ```json
  { "Foundry": { "ProjectEndpoint": "https://<resource>.services.ai.azure.com/api/projects/<project>", "Model": "gpt-5.4-mini" } }
  ```
- **Environment variables** override both, with `__` for the section: `Foundry__Model=gpt-4.1-mini`, `MedAssist__Engine=agent-framework`.

| Setting | Default | What it does |
|---|---|---|
| `Foundry:ProjectEndpoint`, `Foundry:Model` | empty | The Foundry project and model deployment. Sign-in is `az login` (`DefaultAzureCredential`), with no keys. Your account needs the Foundry User role. |
| `MedAssist:Engine` | `prompt-agent` | `prompt-agent` or `agent-framework` |
| `MedAssist:DatabasePath` | `examples/medassist/data/medassist.db` | Relative to the lab's root. This is the file the Python version and the lab's page use, so bookings show in both. |
| `MedAssist:BudgetUsd` | `1.0` | The API stops answering once this run has spent about this much |
| `MedAssist:MaxConversations`, `MaxRounds` | 20, 6 | Open conversations kept; function-call rounds in one turn |
| `Pricing:Models` | gpt-5.4-mini, gpt-4.1-mini | List prices per million tokens (python/common.py's), for the spend cap |

## Run the API for the frontend

```sh
cd dotnet
dotnet run --project src/MedAssist.Api                   # http://127.0.0.1:5080

# in another terminal: the lab's page, with MedAssist's calls sent to .NET and everything else to Python
cd frontend
LLM_LAB_MEDASSIST_API=http://127.0.0.1:5080 npm run dev  # http://localhost:5173/medassist
```

The routes and their JSON are the Python backend's:
- `GET /api/medassist/info`
- `POST /api/medassist/chats`
- `POST /api/medassist/chats/{id}/messages`
- `DELETE /api/medassist/chats/{id}`
- `GET /api/medassist/patients/{id}`
- `POST /api/medassist/reset`
- `GET /api/medassist/phone`

The page needs no changes. The API accepts only the lab's pages:
- requests must carry `X-LLM-Lab: 1`;
- an `Origin`, when sent, must be this machine;
- the `Host` must be listed in `AllowedHosts`.

There's no CORS policy, so other websites can't call it. Real texts and the phone line stay in the Python backend.

## The command line

```sh
cd dotnet
dotnet run --project src/MedAssist.Cli -- create          # once: upload the documents, save a new version of the agent
dotnet run --project src/MedAssist.Cli -- chat            # as Valeria Romano (P001); every tool call is shown
dotnet run --project src/MedAssist.Cli -- chat --patient P002 --engine agent-framework
dotnet run --project src/MedAssist.Cli -- test            # the nine checked cases, each on its own fresh database
dotnet run --project src/MedAssist.Cli -- records --patient P002   # no Azure needed
dotnet run --project src/MedAssist.Cli -- reset           # a fresh database; a copy of the old one goes to generated/transcripts/databases/
dotnet run --project src/MedAssist.Cli -- delete          # remove the agent, its documents and the vector store
```

If you already ran `python medassist.py create`, the agent and the documents are already in Foundry. Both versions use the same `MedAssist` agent and `medassist-knowledge` store.

## Tests

```sh
cd dotnet && dotnet test        # 66 tests, no Azure, no cost
```

| Project | What it checks | With |
|---|---|---|
| `MedAssist.Domain.Tests` | The rules: choose then book, two-step cancel, one slot per patient, a past slot refused, a failed text audited; the toolbox; the JSON the model reads | A throwaway database, a stub repository, a fixed clock |
| `MedAssist.Data.Tests` | The database is Python's slot for slot for a fixed day; free-slot queries; claiming a slot once; upgrading an older database | SQLite in a temporary file |
| `MedAssist.Application.Tests` | Conversations, turns, pricing, the budget, ending the oldest, reset, the scenario runner, settings, failures | A scripted `FakeEngine` |
| `MedAssist.Integrations.Tests` | Our tool loop against scripted Foundry responses; the prompt agent's portal note; `ClinicFunction`; hosted steps; which engine the settings choose | Scripted responders, no network |
| `MedAssist.Api.Tests` | The routes and the page's JSON, the lab-page guard, the error shape and statuses | `WebApplicationFactory`, a fake engine |
| `MedAssist.Cli.Tests` | Usage, failures, chat until an empty line, records, create | A scripted console, fake ports |

`tests/MedAssist.Testing` holds the shared test doubles: `FixedTimeProvider`, `TempPractice`, `FakeEngine` and `StubRepository`.

## Packages

| Package | For |
|---|---|
| `Azure.AI.Projects` 2.0.1 | The Foundry project client, agent versions, conversations, Responses, vector stores |
| `Azure.Identity` | `DefaultAzureCredential` |
| `Microsoft.Agents.AI.Foundry` 1.5.0 | Agent Framework on Foundry. 1.5.0 is its last stable release, and it is built on `Azure.AI.Projects` 2.0, so both engines use one SDK. |
| `Microsoft.Data.Sqlite` | The practice database |
| `Microsoft.Extensions.Hosting` | The CLI's host: configuration, options, DI |
| NUnit, AwesomeAssertions, `Microsoft.AspNetCore.Mvc.Testing` | Tests |

The OpenAI SDK marks the Responses API and vector stores as evaluation-only (`OPENAI001`). Both engines are built on them, as the Python version is, so `Directory.Build.props` accepts that one warning. Every other warning is an error.
