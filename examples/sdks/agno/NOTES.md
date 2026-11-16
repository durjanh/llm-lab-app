# Agno
- Package(s) and version: `agno` 3.2.0 (with `openai` 3.51.0, `mcp` 2.3.0, `fastmcp` 4.2.0)
- Status: active open-source agent framework, formerly Phidata. Agents, teams and workflows, with its own runtime (AgentOS) around them.
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini` through `agno.models.azure.AzureOpenAI`, Entra sign-in with `azure_ad_token_provider` (`az login`, no key).

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `Agent(output_schema=Model)` → `agent.run(prompt).content` is the model |
| Define a tool | plain functions in `Agent(tools=[fn])`, or `@tool`; schema from the signature and docstring |
| Tool loop | the SDK: `agent.run(prompt)` loops until the model answers |
| MCP | `async with MCPTools(command="...", exclude_tools=[...]) as mcp`, then `Agent(tools=[mcp])` |
| Human approval before a tool | `tool(requires_confirmation=True)(fn)`; the run pauses (`run.is_paused`), `run.active_requirements` each take `.confirm()` or `.reject()`, then `agent.continue_run(run)` |
| Step limit / stop | `Agent(tool_call_limit=N)` |
| Multi-agent | `Team(members=[...])` in coordinate, route, broadcast or tasks mode; or `Workflow` steps |
| Tracing / observability | `tool_hooks` see each call; sessions and runs are stored; OpenTelemetry through OpenInference |
| Azure OpenAI with Entra | `AzureOpenAI(azure_endpoint=..., azure_deployment=..., azure_ad_token_provider=...)` |

## Gotchas found while building this
- `MCPTools` needs `fastmcp` (4.x) but does not install it; the error message says what to pip install.
- `MCPTools` takes the server as one command string, so the interpreter and script path are joined with a space (a path with spaces would break).
- The pause and resume API changed: older examples show `run.tools_requiring_confirmation` and `updated_tools`; in 3.x it is `active_requirements` and `agent.continue_run(run)`. Passing only `run_id` fails with "No runs found" unless storage is set up.
- The first full run failed task 5: the team leader's reply dropped the client's name (Northgate). Its instructions now ask the researcher for it; three runs after that passed.
- A `Team` leader writes its own final answer, so its instructions say to reply with the writer's bullets only.

## Results
All five tasks passed on `gpt-5.4-mini` after that fix (see [RESULTS.md](../RESULTS.md)).
