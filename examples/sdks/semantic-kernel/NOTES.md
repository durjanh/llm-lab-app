# Semantic Kernel (Python)
- Package(s) and version: `semantic-kernel[mcp]` 1.46.0 (with `protobuf` for orchestrations), Python 3.12
- Status: Microsoft. The package's own description now opens: "Semantic Kernel is now Microsoft Agent Framework! Microsoft Agent Framework (MAF) is the enterprise‑ready successor to Semantic Kernel", with a migration guide. Still published and working, but new projects should start on Agent Framework.
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini`, `AzureChatCompletion(..., ad_token_provider=...)` with an Entra token provider (keys are off)

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `AzureChatPromptExecutionSettings(response_format=Triage)` passed as `KernelArguments(settings=...)`; parse `response.content` with `Triage.model_validate_json` |
| Define a tool | A plugin class with `@kernel_function(description=...)` methods; parameters described with `Annotated[str, "..."]` |
| Tool loop | The kernel runs it: `FunctionChoiceBehavior.Auto()` (the default when an agent has plugins) |
| MCP | `async with MCPStdioPlugin(name=, command=, args=) as mcp:` then `plugins=[mcp]` (also `MCPSsePlugin`, `MCPStreamableHttpPlugin`) |
| Human approval before a tool | A filter: `@kernel.filter(FilterTypes.AUTO_FUNCTION_INVOCATION)`; set `context.function_result` and skip `await next(context)` to refuse |
| Step limit / stop | `FunctionChoiceBehavior.Auto(maximum_auto_invoke_attempts=10)`; `context.terminate = True` in a filter stops the loop |
| Multi-agent | Orchestrations: `SequentialOrchestration`, `ConcurrentOrchestration`, `GroupChatOrchestration`, `HandoffOrchestration`, `MagenticOrchestration`, run on `InProcessRuntime` (`runtime.start()`, `await orch.invoke(task=, runtime=)`, `await result.get()`) |
| Tracing / observability | OpenTelemetry (`semantic_kernel` spans, GenAI semantic conventions); filters for custom logging |
| Azure OpenAI with Entra | `AzureChatCompletion(deployment_name=, endpoint=, api_version=, ad_token_provider=get_bearer_token_provider(DefaultAzureCredential(), scope))` (or `credential=`) |

## Gotchas found while building this
- Orchestrations import `google.protobuf`, which `semantic-kernel` doesn't install: add `protobuf` or task 5 fails at import.
- The `mcp` extra installs the MCP SDK 1.x (1.30.0 here); fine against the 2.x server in `examples/mcp`.
- The approval filter is per kernel, so the agent must be given that kernel (`ChatCompletionAgent(kernel=kernel, ...)`), otherwise it builds its own and the filter never runs.
- `maximum_auto_invoke_attempts` counts model round trips that call tools, not individual tool calls (three parallel `get_engagement` calls are one step in the trace).
- Declining in the filter returns the refusal text to the model as the tool result; it then explains instead of retrying.

## Results
| Task | Result | Time |
|---|---|---|
| 01_structured | PASS | 2.6s |
| 02_tools | PASS | 3.9s |
| 03_mcp | PASS | 3.7s |
| 04_agent | PASS (`--auto-approve`); declining leaves no write, as designed | 6.6–7.5s |
| 05_multi_agent | PASS once, FAIL once: the writer sometimes omits the client's name, which the shared check requires (see report) | 3.8s |
