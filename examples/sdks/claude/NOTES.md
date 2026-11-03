# Claude API (Anthropic Python SDK)
- Package(s) and version: `anthropic[mcp]` 2.3.0 (with `mcp` 2.3.0)
- Status: Anthropic's official SDK, actively developed. The tool runner and MCP helpers are beta (`client.beta.messages`).
- Model and sign-in used here: `claude-opus-5-5` at low effort, `ANTHROPIC_API_KEY` from the lab's `.env`, with the server-side refusal fallback (`betas=["server-side-fallback-2026-07-01"]`, `fallbacks="default"`).

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `client.beta.messages.parse(..., output_format=PydanticModel)` → `message.parsed_output` (non-beta: `client.messages.parse`) |
| Define a tool | `@beta_tool` on a function; the schema comes from the signature and docstring (`Args:` section) |
| Tool loop | the SDK: `client.beta.messages.tool_runner(tools=[...], max_iterations=N)`, then `.until_done()` or iterate it turn by turn. Manual loop: `while stop_reason == "tool_use"` yourself |
| MCP | local server: `anthropic.lib.tools.mcp.async_mcp_tool(tool, mcp_client)` per tool listed by the MCP client; hosted server: the Messages API MCP connector (`mcp_servers=[...]` + `{"type": "mcp_toolset"}`, beta `mcp-client-2025-11-20`), where Anthropic's servers call it |
| Human approval before a tool | no built-in flag: gate inside the tool function (here `as_tool(fn, before=gate)`), and return a "declined" result the model reads |
| Step limit / stop | `max_iterations` on the tool runner; check `stop_reason` (`end_turn`, `tool_use`, `refusal`, `max_tokens`) |
| Multi-agent | none in the API itself: compose calls (orchestrator and workers, by hand). Hosted: Managed Agents (beta, multi-agent workflows); local harness: the Claude Agent SDK (separate package, Claude Code's harness with subagents) |
| Tracing / observability | iterate the runner to see each turn; `usage` on every message; OpenTelemetry spans in the SDK (see the SDK docs) |
| Azure OpenAI with Entra | n/a. Claude's own sign-in is an API key, `ant auth login` profiles, or Workload Identity Federation. Claude is also on Bedrock, Vertex AI and Microsoft Foundry with their own clients (`AnthropicBedrockMantle`, `AnthropicVertex`, `AnthropicFoundry`) |

## Gotchas found while building this
- The `anthropic` package is now 2.x (the lab's own environment has 1.15); the APIs used here are the same in both.
- `@beta_tool` results must be text or content blocks, not dicts: the shared functions return dicts, so `as_tool` wraps them with `json.dumps` (and `functools.wraps` keeps the signature for the schema).
- Opus 5.5 rejects `thinking: {type: "disabled"}`, and its default effort is `medium`: set `output_config={"effort": ...}` explicitly.
- The MCP helpers accept the MCP SDK 2.x `Client` as well as the 1.x `ClientSession`: they only call `call_tool(name=..., arguments=...)`.
- Not built here: the Claude Agent SDK (needs the Claude Code CLI; a full harness with built-in file and shell tools, hooks, permissions and subagents) and Managed Agents (Anthropic hosts the loop and a sandbox per session). Both are the "harness" end of Anthropic's stack; this folder is the API end.

## Results
| Task | Result | Time |
|---|---|---|
| 01_structured | PASS | 3.5s |
| 02_tools | PASS | 5.5s |
| 03_mcp | PASS | 8.0s |
| 04_agent (`--auto-approve`) | PASS: one risk on ENG-107, after one approval | 9.9s |
| 05_multi_agent | PASS | 7.6s |
