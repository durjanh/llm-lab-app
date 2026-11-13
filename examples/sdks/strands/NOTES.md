# Strands Agents (AWS)
- Package(s) and version: `strands-agents[anthropic]` 1.64.0 (with `strands-agents-tools` 0.9.0, `mcp` 2.3.0)
- Status: AWS open-source SDK, active. A model-driven agent loop with built-in multi-agent patterns (Graph, Swarm, agents as tools).
- Model and sign-in used here: `claude-haiku-5-5` through Strands' Anthropic provider (`strands.models.anthropic.AnthropicModel`), `ANTHROPIC_API_KEY` from the lab's `.env`. Strands' default provider is Amazon Bedrock; Bedrock, OpenAI, Ollama and others are swappable models.

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `agent(prompt, structured_output_model=Model)` → `result.structured_output` |
| Define a tool | `@strands.tool` on a function (or `tool(fn)`); schema from the signature and docstring |
| Tool loop | the SDK: calling `agent(prompt)` runs model → tools → model until it answers |
| MCP | `MCPClient(lambda: stdio_client(params))`, then `with mcp: mcp.list_tools_sync()` and pass the tools to the agent |
| Human approval before a tool | a `BeforeToolCallEvent` hook that sets `event.cancel_tool = "message"`; also `event.interrupt(...)` for pause and resume |
| Step limit / stop | no agent-level setting: count calls in a hook and cancel; Graph has `set_max_node_executions` |
| Multi-agent | `GraphBuilder` (used here), `Swarm`, or `agent.as_tool()` |
| Tracing / observability | OpenTelemetry built in; hooks see every event |
| Azure OpenAI with Entra | not used here (Claude folder); Strands has an `OpenAIModel` for OpenAI-compatible endpoints |

## Gotchas found while building this
- It pins an older `anthropic` (0.125) than the Claude folder (2.x); that is why it has its own `.venv`.
- Printing the agent's streamed output is on by default: pass `callback_handler=None` to keep the output to the final answer.
- No step-limit setting on `Agent`; the hook in `04_agent.py` is the limit. `GraphBuilder` warns that a graph is unbounded until `set_max_node_executions` is called.
- The graph passes the researcher's reply to the writer, so facts the researcher drops (the client's name) are lost: its prompt asks for the name.

## Results
All five tasks passed with `claude-haiku-5-5` (see [RESULTS.md](../RESULTS.md)).
