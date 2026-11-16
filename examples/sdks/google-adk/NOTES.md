# Google Agent Development Kit (ADK)
- Package(s) and version: `google-adk` 2.14.1 (with `litellm` 1.109.1, `openai` 3.51.0, `mcp` 2.3.0)
- Status: Google's open-source agent framework, active; 2.x adds a graph `Workflow` and deprecates `SequentialAgent` in its favour.
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini` through ADK's `LiteLlm` wrapper (`azure/<deployment>`), Entra sign-in with LiteLLM's `azure_ad_token_provider` (`az login`, no key). ADK is built for Gemini; any other provider goes through LiteLLM.

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `LlmAgent(output_schema=Model)`; the reply is JSON text, validated with `Model.model_validate_json` |
| Define a tool | plain functions in `LlmAgent(tools=[fn])`, wrapped as `FunctionTool`; schema from the signature and docstring |
| Tool loop | the runner: `Runner.run_async(...)` streams events until the final response |
| MCP | `McpToolset(connection_params=StdioConnectionParams(...), tool_filter=[...])` in `tools=[...]`; `await toolset.close()` |
| Human approval before a tool | `FunctionTool(fn, require_confirmation=True)`; the run emits an `adk_request_confirmation` call, and a second `run_async` on the same session sends back a `FunctionResponse` with `{"confirmed": bool}` |
| Step limit / stop | `RunConfig(max_llm_calls=N)` |
| Multi-agent | `SequentialAgent`, `ParallelAgent`, `LoopAgent`, or `LlmAgent(sub_agents=[...])` with transfer; `output_key` plus `{key}` in an instruction passes state |
| Tracing / observability | every event from the runner (function calls, responses); OpenTelemetry built in; a dev UI (`adk web`) |
| Azure OpenAI with Entra | `LiteLlm(model="azure/<deployment>", api_base=..., api_version=..., azure_ad_token_provider=...)` |

## Gotchas found while building this
- Everything runs through a `Runner` and a session service even for one call, so `_adk.py` has a small `ask()` helper that creates the session and yields events.
- `SequentialAgent` prints a deprecation warning (2.x prefers `Workflow`, which cannot yet be a sub-agent of an `LlmAgent`); this folder keeps `SequentialAgent`.
- The confirmation request arrives as an event whose function call is `adk_request_confirmation`, with the original call in `args["originalFunctionCall"]`.
- ADK loads each agent's final answer as the last event with `is_final_response()`; events from sub-agents are told apart with `event.author`.

## Results
All five tasks passed on `gpt-5.4-mini` (see [RESULTS.md](../RESULTS.md)).
