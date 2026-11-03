# LangChain
- Package(s) and version: langchain 1.4.7, langchain-core 1.7.3, langchain-openai 1.7.3, langchain-mcp-adapters 0.3.2 (runs on langgraph 1.2.18, installed as a dependency)
- Status: maintained by LangChain Inc; actively developed. Since 1.0 the agent API is `create_agent`, built on LangGraph; the older chains and `AgentExecutor` are legacy.
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini` via `AzureChatOpenAI(azure_ad_token_provider=...)` (Entra, no key)

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `llm.with_structured_output(Triage).invoke(prompt)` returns a `Triage`; in an agent, `create_agent(..., response_format=Triage)` |
| Define a tool | `tool(parse_docstring=True)(fn)` or `@tool`: schema from type hints, descriptions from the Google-style docstring |
| Tool loop | `create_agent(model, tools, system_prompt=...)`; the agent (a prebuilt LangGraph graph) runs model and tools until the model answers |
| MCP | `MultiServerMCPClient({"name": {"transport": "stdio", "command": ..., "args": [...]}})`, `await client.get_tools()` gives LangChain tools; use `ainvoke` |
| Human approval before a tool | `HumanInTheLoopMiddleware(interrupt_on={"log_risk": {"allowed_decisions": ["approve", "reject"]}})` + a checkpointer; `invoke(..., version="v2").interrupts`, then `invoke(Command(resume={"decisions": [{"type": "approve"}]}))` |
| Step limit / stop | `ModelCallLimitMiddleware(run_limit=12, exit_behavior="end")` (also `ToolCallLimitMiddleware`); or `recursion_limit` in the run config |
| Multi-agent | Subagents as tools: wrap `create_agent(...)` instances in `@tool` functions for a supervisor agent (`name=` on each agent) |
| Tracing / observability | LangSmith (`LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`), callbacks; here a `@wrap_tool_call` middleware prints each tool call |
| Azure OpenAI with Entra | `AzureChatOpenAI(azure_endpoint=..., azure_deployment=..., api_version=..., azure_ad_token_provider=get_bearer_token_provider(...))` |

## Gotchas found while building this
- Middleware is the extension point in 1.x (`before_model`, `after_model`, `wrap_model_call`, `wrap_tool_call` decorators); human approval, limits, retries, PII and summarisation are all middleware.
- Human approval needs a checkpointer and a `thread_id`; the pause is a LangGraph interrupt. Use `invoke(..., version="v2")` and read `.interrupts` / `.value` (dict-style `result["__interrupt__"]` is deprecated).
- The default `interrupt_mode="batched"` gives one interrupt per model turn listing every gated call; answer with decisions in the same order. `"per_call"` is planned to become the default.
- MCP tools from langchain-mcp-adapters are async only: use `ainvoke`. This venv has the MCP SDK 1.30; it talks to the 2.x server in examples/mcp without problems.
- In task 5 the writer called the client "ENG-101" until the supervisor was told to pass on the client's name: multi-agent hand-offs lose facts unless the coordinator is explicit.

## Results
| Task | Result | Time |
|---|---|---|
| 01_structured | PASS | 2.3s |
| 02_tools | PASS | 3.8s |
| 03_mcp | PASS | 6.0s |
| 04_agent (`--auto-approve`) | PASS: one risk on ENG-107; declining at the prompt logs nothing and the agent says so | 6.9s |
| 05_multi_agent | PASS | 7.7s |
