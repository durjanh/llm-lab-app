# OpenAI Python SDK (plain)
- Package(s) and version: `openai` 3.41.0 (plus `mcp` 2.3.0 for task 3)
- Status: OpenAI's official client, actively developed. It is a thin client over the API: no agent loop, no MCP client (its hosted MCP tool needs a public URL).
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini` (Chat Completions) on the v1 endpoint, Entra token callable as `api_key`.

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `client.chat.completions.parse(..., response_format=PydanticModel)` → `message.parsed` |
| Define a tool | A JSON schema per function: `{"type": "function", "function": {name, description, parameters}}` (built here from the signature and docstring in `_common.tool_schema`; `openai.pydantic_function_tool(Model)` does it from a pydantic model) |
| Tool loop | **You** write it: call → read `message.tool_calls` → run each → append `{"role": "tool", "tool_call_id", "content"}` → call again until no tool calls |
| MCP | Not built in for local servers: use the `mcp` client (`Client(StdioServerParameters(...))`), pass `tool.input_schema` as `parameters`, forward calls with `call_tool` |
| Human approval before a tool | Your own `if` before running the call; return an error result to the model when declined |
| Step limit / stop | Your loop's `range(MAX_STEPS)` |
| Multi-agent | No construct: two prompts chained in your code (the handoff is a variable) |
| Tracing / observability | None built in: log in your loop, or add OpenTelemetry instrumentation yourself |
| Azure OpenAI with Entra | `OpenAI(base_url=f"{endpoint}/openai/v1/", api_key=get_bearer_token_provider(DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default"))` |

## Gotchas found while building this
- The shared tools use `from __future__ import annotations`, so annotations are strings: resolve them with `typing.get_type_hints` before building schemas.
- MCP SDK 2.x names are snake_case (`tool.input_schema`, `result.structured_content`).
- Append the assistant message object itself to `messages` before the tool results, or the API rejects the tool messages.
- Task 5 is flaky (about half the runs): the writer often omits the client's name because `shared.tasks.UPDATE_BRIEF` doesn't ask for it.

## Results
| Task | Result | Time |
|---|---|---|
| 01_structured | PASS | 2.0s |
| 02_tools | PASS | 5.9s |
| 03_mcp | PASS | 7.1s |
| 04_agent | PASS (approval prompt; declining correctly leaves no write) | 7.4s |
| 05_multi_agent | PASS 2 of 4 runs: correct facts, client name sometimes left out | 2.9–4.7s |
