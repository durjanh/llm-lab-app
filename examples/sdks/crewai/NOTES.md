# CrewAI
- Package(s) and version: `crewai` 1.15.33 with `crewai-tools` 1.15.33, `azure-ai-inference` 1.0.0b9 (CrewAI's native Azure provider), `mcp` 1.30.0; Python 3.12
- Status: CrewAI Inc.; open source (MIT), actively developed. 1.x has native provider clients (OpenAI, Azure, Anthropic, Bedrock, Gemini) instead of going through LiteLLM.
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini`, `LLM(model="azure/gpt-5.4-mini", endpoint=..., api_version=..., credential_scopes=["https://cognitiveservices.azure.com/.default"])` with no API key, so CrewAI uses `DefaultAzureCredential` (az login)

Run: `python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt`, then `.venv/bin/python 01_structured.py` … `04_agent.py --auto-approve`. Shared setup (telemetry off, the Azure LLM, the tool wrapper) is in `crew_common.py`.

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | `Task(..., output_pydantic=Triage)`; read `crew.kickoff().pydantic` |
| Define a tool | `@tool("name")` from `crewai.tools` on a typed, docstringed function (or subclass `BaseTool`); name, docstring and type hints become the schema |
| Tool loop | CrewAI's agent executor runs it: `Crew(agents, tasks).kickoff()` → the agent calls tools until it can answer the task's `expected_output` |
| MCP | `Agent(mcps=[MCPServerStdio(command, args, tool_filter=create_static_tool_filter(allowed_tool_names=[...]))])` from `crewai.mcp`; also `MCPServerHTTP`/`MCPServerSSE`, and `MCPServerAdapter` in crewai-tools |
| Human approval before a tool | A hook: `@before_tool_call(tools=["log_risk"])` from `crewai.hooks`; return `False` to block the call, `None` to allow (the hook context also has `request_human_input`). `Task(human_input=True)` asks for feedback on a task's output instead |
| Step limit / stop | `Agent(max_iter=12, max_execution_time=300)`; also `max_rpm`, and `Task(guardrail=...)` to validate outputs |
| Multi-agent | `Crew(agents=[...], tasks=[...], process=Process.sequential)` with `Task(context=[earlier_task])`; `Process.hierarchical` adds a manager agent; `Flow` for event-driven pipelines |
| Tracing / observability | `@before_tool_call` / `@after_tool_call` and LLM hooks, the event bus, `verbose=True`; CrewAI's hosted tracing (opt-in), or OpenTelemetry |
| Azure OpenAI with Entra | No `api_key` → `DefaultAzureCredential`; pass `credential_scopes=["https://cognitiveservices.azure.com/.default"]` |

## Gotchas found while building this
- **Telemetry is on by default**: CrewAI sends anonymous usage telemetry, and on a first run offers to collect traces. Switched off in `crew_common.py` with `CREWAI_DISABLE_TELEMETRY=true`, `CREWAI_TRACING_ENABLED=false` and `OTEL_SDK_DISABLED=true`.
- **String annotations break tool schemas**: the shared tools use `from __future__ import annotations`, and `@tool` builds a pydantic model from the raw annotations, failing with "`Search_Engagements` is not fully defined; you should define `Literal`". `crew_common.as_tool` wraps each function with resolved type hints and removes `__wrapped__` (otherwise signature inspection follows it back to the strings).
- **Credential scope**: without `credential_scopes`, the Azure AI Inference client asks for a token for its own default scope, which Azure OpenAI does not accept; Azure OpenAI needs `https://cognitiveservices.azure.com/.default`.
- **Endpoint**: give the resource endpoint (`https://<resource>.openai.azure.com`); CrewAI appends `/openai/deployments/<deployment>` itself from the `azure/<deployment>` model name.
- **Approval is a hook, not a tool feature**: blocking returns an error to the agent, which then reports that it could not complete the write (tested: declining leaves the register unchanged).
- Harmless warning on every call: "Using an approximate input token count for model 'gpt-5.4-mini'".

## Results
| Task | Result | Time |
|---|---|---|
| 01_structured | PASS (repairs, high) | 3.9 s |
| 02_tools | PASS (ENG-101, 53.3%) | 3.4 s |
| 03_mcp | PASS (ENG-101, 53.3%) | 6.4 s |
| 04_agent | PASS (one risk on ENG-107, medium, Eleni Papadakis; declining blocks it) | 5.6 s |
| 05_multi_agent | PASS (Northgate, £96,000 / 53.3%) | 3.3 s |

Times are from the shared check's clock (process start to check), Azure OpenAI gpt-5.4-mini, 30 October 2026.
