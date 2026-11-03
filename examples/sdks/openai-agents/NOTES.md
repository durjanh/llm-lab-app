# OpenAI Agents SDK
- Package(s) and version: `openai-agents` 0.24.0 (on `openai` 3.41.0; `mcp` 2.3.0)
- Status: OpenAI's agent framework (successor to Swarm), actively developed, pre-1.0.
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini` via `OpenAIChatCompletionsModel` with an `AsyncOpenAI` client on the v1 endpoint and an async Entra token callable. OpenAI tracing switched off (`set_tracing_disabled(True)`): its default exporter sends traces to OpenAI's platform with an OpenAI key.

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `Agent(..., output_type=PydanticModel)` → `result.final_output` is the model instance |
| Define a tool | `@function_tool` or `function_tool(fn)`: schema from signature + docstring (Google, NumPy or Sphinx style) |
| Tool loop | **The SDK**: `Runner.run(agent, input)` / `Runner.run_sync(...)` |
| MCP | `async with MCPServerStdio(params={"command", "args"}) as s: Agent(..., mcp_servers=[s])` (also `MCPServerStreamableHttp`, `MCPServerSse`, and hosted MCP tools on the Responses API) |
| Human approval before a tool | `function_tool(fn, needs_approval=True)` (or a callable) → run stops with `result.interruptions`; `state = result.to_state(); state.approve(item)` / `state.reject(item)`; `Runner.run(agent, state)` resumes |
| Step limit / stop | `Runner.run(..., max_turns=N)` → raises `MaxTurnsExceeded` |
| Multi-agent | `Agent(handoffs=[other])` (control passes over), or `agent.as_tool(...)` (a manager calls specialists and keeps control) |
| Tracing / observability | Built-in tracing (spans per agent, tool, handoff) to OpenAI's dashboard by default; `add_trace_processor(...)` for your own exporter; `RunHooks` / `AgentHooks` for callbacks (`on_tool_start`, `on_handoff`…); also guardrails (`input_guardrails`, `output_guardrails`, tool guardrails) |
| Azure OpenAI with Entra | `OpenAIChatCompletionsModel(model=deployment, openai_client=AsyncOpenAI(base_url=f"{endpoint}/openai/v1/", api_key=async_token_fn))`, or `set_default_openai_client(...)` + `set_default_openai_api("chat_completions")` |

## Gotchas found while building this
- `AsyncOpenAI` wants `api_key` as an *async* callable; wrap the sync Entra token provider.
- Tracing to OpenAI is on by default and needs an OpenAI key to export; with Azure only, switch it off (as here) or add your own trace processor.
- Approval is a pause and resume, not a callback: keep `result.to_state()` and pass the state back to `Runner.run`.
- `RunHooks.on_tool_start` gets a `ToolContext` with `tool_name` and `tool_arguments` for function tools; for the MCP task this script reads the calls from `result.new_items` after the run.

## Results
| Task | Result | Time |
|---|---|---|
| 01_structured | PASS | 1.8s |
| 02_tools | PASS | 5.8s |
| 03_mcp | PASS | 6.3s |
| 04_agent | PASS (approval interrupt + resume; rejecting leaves no write) | 6.3s |
| 05_multi_agent | PASS (handoff researcher → writer) | 4.1s |
