# Microsoft Agent Framework (Python)
- Package(s) and version: `agent-framework-core` 1.23.0, `agent-framework-openai` 1.17.0, `agent-framework-orchestrations` 1.4.0 (plus `mcp` 2.3.0, `tenacity`)
- Status: Microsoft's actively developed agent SDK, the successor to Semantic Kernel and AutoGen (Microsoft recommends it over both for new work). Python and .NET.
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini` through `OpenAIChatCompletionClient(azure_endpoint=..., credential=DefaultAzureCredential())`: Entra sign-in, no keys.

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `await agent.run(prompt, options={"response_format": PydanticModel})` → `response.value` |
| Define a tool | `tool(fn)` or `@tool`; schema from the signature (use `Annotated[..., Field(description=...)]` for argument descriptions) |
| Tool loop | the chat client's function-invocation layer runs it automatically inside `agent.run` |
| MCP | `MCPStdioTool(name, command, args=[...], allowed_tools=[...])` (also `MCPStreamableHTTPTool`, `MCPWebsocketTool`); `async with` it, then pass it in `tools=[...]` |
| Human approval before a tool | `tool(fn, approval_mode="always_require")`: the run returns `response.user_input_requests`; answer each with `request.to_function_approval_response(True/False)` in `agent.run(Message("user", answers), session=session)` |
| Step limit / stop | `function_invocation_configuration={"max_iterations": N, "max_function_calls": M}` on the chat client |
| Multi-agent | `agent_framework.orchestrations`: `SequentialBuilder`, `ConcurrentBuilder`, `GroupChatBuilder`, `HandoffBuilder`, `MagenticBuilder`; or your own graph with `WorkflowBuilder` and executors (see `examples/agent-framework/`) |
| Tracing / observability | middleware (`@function_middleware`, agent and chat middleware); built-in OpenTelemetry (`agent_framework.observability`); DevUI shows runs and traces |
| Azure OpenAI with Entra | `credential=DefaultAzureCredential()` (or a token provider) on `OpenAIChatCompletionClient` / `OpenAIChatClient`; Foundry projects via `agent_framework.foundry.FoundryChatClient(project_endpoint=...)` |

## Chat Completions or Responses
`_af.py` uses Chat Completions by default; `AF_API=responses` runs any task on the Responses API with no other change, and all five pass both ways. `06_responses.py` runs the same two-turn conversation three ways and then a hosted tool. One run:

| | Turn 1 tokens (with the tool loop) | Turn 2 tokens | Kept on this machine | Kept on the server |
|---|---|---|---|---|
| Chat Completions | 1,814 in | 1,114 in | 8 messages | nothing |
| Responses, store on (default) | 1,592 in | 1,041 in | 0 messages | the last response id (`resp_...`) |
| Responses, `store=False` | 1,592 in | 1,037 in | 8 messages | nothing |

- Server-side state saves you sending the history, not paying for it: the model still reads it, so turn 2's input tokens barely change.
- With store on, the conversation lives in Azure for 30 days by default, and `session.service_session_id` is the only handle. That id is not access control: check it belongs to the user before you accept one from a client.
- The code interpreter (`OpenAIChatClient.get_code_interpreter_tool()`) is a hosted tool: the model wrote and ran Python in Azure's sandbox and the reply carried `code_interpreter_tool_call` and `code_interpreter_tool_result` contents. Only the Responses client offers it.

## Gotchas found while building this
- The names mislead: `OpenAIChatClient` is the **Responses** client, `OpenAIChatCompletionClient` is Chat Completions.
- Provider clients and orchestrations are separate packages: `agent_framework.openai` needs `agent-framework-openai`, `agent_framework.orchestrations` needs `agent-framework-orchestrations`; the import fails with a message naming the package.
- `MCPStdioTool` needs `tenacity`, which nothing installs for you ("MCP subscription recovery requires `tenacity`").
- `SequentialBuilder` yields only the last participant's response by default; `output_from="all"` gives one `AgentResponse` per participant.
- The whole docstring, `Args:` section included, becomes the tool description; the argument schema gets no descriptions from it. For per-argument descriptions use `Annotated[..., Field(description=...)]`.
- In task 5 the researcher added "on track" without any data saying so; the writer dropped it. A reminder that a second agent does not check facts unless told to.

## Results
| Task | Result | Time |
|---|---|---|
| 01_structured | PASS | 2.4s |
| 02_tools | PASS | 4.2s |
| 03_mcp | PASS | 4.9s |
| 04_agent (`--auto-approve`) | PASS: one risk on ENG-107, after one approval through `approval_mode` | 6.8s |
| 05_multi_agent | PASS | 3.3s |
