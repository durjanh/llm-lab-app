# LlamaIndex (agents and Workflows)
- Package(s) and version: `llama-index-core` 0.14.26, `llama-index-workflows` 2.26.1, `llama-index-llms-azure-openai` 0.7.0, `llama-index-tools-mcp` 0.7.0 (with `openai` 3.51.0, `mcp` 2.3.0)
- Status: active. Began as a data and retrieval framework; now `FunctionAgent` / `AgentWorkflow` for agents and `Workflow` (events and steps, its own package) for control flow.
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini` through `llama_index.llms.azure_openai.AzureOpenAI`, Entra sign-in with `azure_ad_token_provider` (`az login`, no key). `_li.py` has a six-line subclass, see the gotchas.

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `llm.as_structured_llm(Model).chat(messages)` → `response.raw` |
| Define a tool | plain functions in `FunctionAgent(tools=[fn])` (become `FunctionTool`); schema from the signature and docstring |
| Tool loop | the SDK: `await agent.run(prompt)`; a `FunctionAgent` is itself a Workflow |
| MCP | `McpToolSpec(BasicMCPClient(command, args=[...]), allowed_tools=[...])` → `await spec.to_tool_list_async()` |
| Human approval before a tool | the tool emits `InputRequiredEvent` with `ctx.write_event_to_stream` and waits with `await ctx.wait_for_event(HumanResponseEvent)`; the caller answers with `handler.ctx.send_event(...)` |
| Step limit / stop | `agent.run(prompt, max_iterations=N)` |
| Multi-agent | `AgentWorkflow` (hand-offs between agents), or your own `Workflow` of `@step`s passing events (task 5) |
| Tracing / observability | the event stream (`handler.stream_events()`), plus instrumentation callbacks to Arize, Langfuse and others |
| Azure OpenAI with Entra | `AzureOpenAI(engine=deployment, azure_endpoint=..., azure_ad_token_provider=..., use_azure_ad=True)` (with the subclass below) |

## Gotchas found while building this
- With a token provider, `AzureOpenAI` sends the token as `api_key` as well as the provider, and `openai` 3.x refuses both ("mutually exclusive"). Using `use_azure_ad=True` without a provider sends the token as a key and gets a 401. `_li.py` subclasses it and drops `api_key`.
- `agent.run(...)` needs a running event loop (it starts a task straight away), so even a one-shot script wraps it in `asyncio.run(main())`.
- A step that waits for an event (`wait_for_event`) re-runs from its start when the answer arrives, so the `InputRequiredEvent` and the tool call appear twice on the stream. `04_agent.py` ignores repeats; the write itself happens once because the answer is already waiting on the second pass.
- `log_risk` in task 4 needs a `Context` argument to emit and wait for events, so it is a thin wrapper around the shared function rather than the shared function itself.

## Results
All five tasks passed on `gpt-5.4-mini` (see [RESULTS.md](../RESULTS.md)). Task 5 is a `Workflow` with two steps and a `FactsEvent` between them.
