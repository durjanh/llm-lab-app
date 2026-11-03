# AutoGen (AgentChat)
- Package(s) and version: `autogen-agentchat` 0.7.5, `autogen-core` 0.7.5, `autogen-ext[openai,azure,mcp]` 0.7.5, Python 3.12
- Status: Microsoft Research; **archived**. The package metadata doesn't say so, but the GitHub README (microsoft/autogen) is badged "archived" and says: "AutoGen is now archived and no longer maintained by Microsoft", "New users should start with Microsoft Agent Framework", with a migration guide. It warns against production use and says security fixes are no longer made.
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini`, `AzureOpenAIChatCompletionClient(..., azure_ad_token_provider=...)` with an Entra token provider

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `AssistantAgent(..., output_content_type=Triage)`; the last message is a `StructuredMessage[Triage]` whose `.content` is the object |
| Define a tool | Pass plain (typed, docstringed) Python functions in `tools=[...]`; AutoGen wraps them in `FunctionTool` |
| Tool loop | The agent runs it: `max_tool_iterations=N` rounds, `reflect_on_tool_use=True` for a final text answer |
| MCP | `async with McpWorkbench(StdioServerParams(command=, args=)) as wb:` then `AssistantAgent(..., workbench=wb)` (or `mcp_server_tools(...)`) |
| Human approval before a tool | No hook for tools on `AssistantAgent`: put the approval inside the tool function (here), or use a `UserProxyAgent` in a team |
| Step limit / stop | `max_tool_iterations`; teams use termination conditions (`MaxMessageTermination`, `TextMentionTermination`, `TokenUsageTermination`, `TimeoutTermination`…) |
| Multi-agent | Teams: `RoundRobinGroupChat`, `SelectorGroupChat`, `MagenticOneGroupChat` (and handoffs) with a `termination_condition` |
| Tracing / observability | `run_stream()` events (`ToolCallRequestEvent`, `ToolCallExecutionEvent`…), `Console(...)`, OpenTelemetry in autogen-core |
| Azure OpenAI with Entra | `AzureOpenAIChatCompletionClient(azure_deployment=, model=, azure_endpoint=, api_version=, azure_ad_token_provider=..., model_info={...})` |

## Gotchas found while building this
- `autogen-ext`'s MCP module imports `mcp.shared.context.RequestContext`, which the MCP SDK 2.x removed: pin `mcp<2` or `03_mcp.py` fails at import. A sign of the archived status.
- A deployment name AutoGen doesn't recognise (such as `gpt-5.4-mini`) needs `model_info` with `vision`, `function_calling`, `json_output`, `family` and `structured_output`, or the client refuses to start.
- `max_tool_iterations` defaults to 1: without raising it, the agent stops after one round of tool calls.
- With `output_content_type`, the OpenAI library prints a harmless `PydanticSerializationUnexpectedValue` warning.
- In a team's result, tool calls and their results appear as extra items from the same agent, but `MaxMessageTermination` counts only chat messages: `MaxMessageTermination(3)` here is the task, the researcher's answer and the writer's answer.

## Results
| Task | Result | Time |
|---|---|---|
| 01_structured | PASS | 3.1s |
| 02_tools | PASS | 5.3s |
| 03_mcp | PASS (after pinning `mcp<2`) | 4.6s |
| 04_agent | PASS (`--auto-approve`) | 6.0s |
| 05_multi_agent | PASS 1 of 3 runs: the writer often omits the client's name, which the shared check requires (see report) | 2.9–4.5s |
