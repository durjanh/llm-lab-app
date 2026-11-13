# PydanticAI
- Package(s) and version: `pydantic-ai-slim[anthropic,mcp]` 2.68.0 (with `anthropic` 2.8.0, `mcp` 2.3.0, `fastmcp` 4.1.8)
- Status: Pydantic's agent framework, active; V2 renamed some classes (`MCPServerStdio` is now `MCPToolset`).
- Model and sign-in used here: `claude-haiku-5-5` through `pydantic_ai.models.anthropic.AnthropicModel`, `ANTHROPIC_API_KEY` from the lab's `.env`. Other providers (Bedrock, Vertex, Foundry, OpenAI, Azure) are other model/provider classes.

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `Agent(model, output_type=Model)` → `result.output`; invalid replies are retried |
| Define a tool | `Agent(tools=[fn])`, `@agent.tool` / `@agent.tool_plain`; schema from the signature and docstring |
| Tool loop | the SDK: `agent.run_sync(prompt)` loops until the output is produced |
| MCP | `MCPToolset(StdioTransport(...))` in `Agent(toolsets=[...])`, run inside `async with agent:`; `.filtered(...)` hides tools |
| Human approval before a tool | `Tool(fn, requires_approval=True)` plus `output_type=[str, DeferredToolRequests]`; answer with `DeferredToolResults` in a second run (pause and resume) |
| Step limit / stop | `UsageLimits(tool_calls_limit=..., request_limit=...)` |
| Multi-agent | agent delegation (a tool runs another agent, `usage=ctx.usage`), programmatic hand-off, or `pydantic-graph` |
| Tracing / observability | Logfire or any OpenTelemetry backend; `event_stream_handler` sees each tool call |
| Azure OpenAI with Entra | not used here; PydanticAI has an Azure provider for OpenAI models |

## Gotchas found while building this
- V2 renames: `MCPServerStdio` raises an ImportError pointing at `MCPToolset`; the `[mcp]` extra brings `fastmcp`.
- A startup banner prints unless `PYDANTIC_AI_NO_BANNER=1`; `_pai.py` sets it.
- With `[str, DeferredToolRequests]` as the output type, Haiku sometimes replied in text asking for approval instead of calling the tool; the script tells it approval is handled by the system.
- The trace handler sees a gated call twice: once when requested, once when it runs after approval.

## Results
All five tasks passed with `claude-haiku-5-5` (see [RESULTS.md](../RESULTS.md)).
