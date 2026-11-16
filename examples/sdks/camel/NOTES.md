# CAMEL-AI
- Package(s) and version: `camel-ai` 0.2.90 (with `openai` 3.51.0, `mcp` 1.30.0)
- Status: active, from the CAMEL research community. Known for role-playing agent societies; now also `Workforce` (a coordinator, task planner and workers).
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini` through `ModelFactory.create(ModelPlatformType.AZURE, ...)`, Entra sign-in with `azure_ad_token_provider` (`az login`, no key).

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `agent.step(prompt, response_format=Model)` → `response.msgs[0].parsed` |
| Define a tool | `FunctionTool(fn)` in `ChatAgent(tools=[...])`; schema from the signature and docstring |
| Tool loop | the SDK: `agent.step(prompt)` runs tools until the model answers |
| MCP | `MCPToolkit(config_dict={"mcpServers": {...}})` as a context manager, then `toolkit.get_tools()` |
| Human approval before a tool | `external_tools=[...]`: CAMEL stops and returns `response.info["external_tool_call_requests"]`; the caller runs the call and records the result in memory, then steps again |
| Step limit / stop | `ChatAgent(max_iteration=N)` |
| Multi-agent | `Workforce` (auto-decomposed or pipeline mode), `RolePlaying` (two agents talking), `BabyAGI` |
| Tracing / observability | `ToolCallingRecord`s in `response.info["tool_calls"]`; optional AgentOps; the Workforce prints its own log |
| Azure OpenAI with Entra | `ModelFactory.create(model_platform=ModelPlatformType.AZURE, model_type=deployment, url=endpoint, api_version=..., azure_ad_token_provider=...)` |

## Gotchas found while building this
- It needs the MCP SDK 1.x: `camel.toolkits` imports `mcp.server.FastMCP`, which 2.x removed, so even `FunctionTool` fails to import on `mcp` 2.x.
- There is no public way to hand a tool result back after an external tool call. `04_agent.py` uses the private `agent._record_tool_calling(...)` and steps again; this may change between releases.
- An unknown model name logs a warning that the context window is not defined (`gpt-5.4-mini`); it is harmless.
- `Workforce` prints a lot (every task, worker reply and quality score) and spends several extra model calls on the coordinator and a quality check, so task 5 is the slowest of the five and costs the most.
- Pipeline mode still lets the coordinator choose which worker takes each task, so worker descriptions matter.

## Results
All five tasks passed on `gpt-5.4-mini` (see [RESULTS.md](../RESULTS.md)).
