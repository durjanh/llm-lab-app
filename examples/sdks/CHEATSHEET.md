# Agent SDK cheatsheet

Eleven Python SDKs doing the same five tasks with the same tools, data and prompts (see [TASKS.md](TASKS.md)): structured output, function tools, the same tools over MCP, an autonomous agent with human approval before a write, and the SDK's own multi-agent pattern. Every example ran for real on 30 October 2026, on Azure OpenAI `gpt-5.4-mini` with Entra sign-in (no keys), except the Claude SDK, which used `claude-opus-5-5`. Strands Agents and PydanticAI were added on 13 November 2026 and ran on `claude-haiku-5-5` through their Anthropic providers. Exact versions are in each folder's `requirements.txt`; detail and gotchas in each `NOTES.md`.

## At a glance

| SDK | Version | Who / status | What kind of thing it is | Reach for it when |
|---|---|---|---|---|
| [OpenAI SDK](openai/) | `openai` 3.41 | OpenAI, active | A thin API client: you write every loop | You want full control and no framework |
| [OpenAI Agents SDK](openai-agents/) | `openai-agents` 0.24 | OpenAI, active, pre-1.0 | Agents, handoffs, guardrails, tracing | OpenAI-centred apps; handoff-style multi-agent |
| [Claude SDK](claude/) | `anthropic[mcp]` 2.3 | Anthropic, active | API client + beta tool runner and MCP helpers | Claude apps; the harness end is the separate **Claude Agent SDK** and **Managed Agents** |
| [Microsoft Agent Framework](agent-framework/) | core 1.23 | Microsoft, active; **successor to Semantic Kernel and AutoGen** | Agents, middleware, MCP, approvals, workflows, DevUI | Azure / Microsoft estates; .NET and Python; new work Microsoft would have used SK or AutoGen for |
| [Semantic Kernel](semantic-kernel/) | 1.46 | Microsoft; superseded by Agent Framework (migration guide) | Kernel + plugins + filters + orchestrations | Existing SK code only |
| [AutoGen](autogen/) | AgentChat 0.7.5 | Microsoft Research; **archived**, no longer maintained, no security fixes | Conversational agent teams | Existing AutoGen code only; migrate |
| [LangChain](langchain/) | 1.4 | LangChain Inc, active | High-level `create_agent` with middleware, on LangGraph | Fast agents with many integrations |
| [LangGraph](langgraph/) | 1.2 | LangChain Inc, active | Explicit state graphs: checkpoints, interrupts, durable runs | Long-running, resumable, auditable workflows where you want every step visible |
| [CrewAI](crewai/) | 1.15 | CrewAI Inc, active | Role-based agents and tasks in crews; flows | Role/task pipelines, quickly |

## Concept by concept

### Structured output
| SDK | How |
|---|---|
| OpenAI | `client.chat.completions.parse(..., response_format=Model)` → `message.parsed` |
| OpenAI Agents | `Agent(output_type=Model)` → `result.final_output` |
| Claude | `client.messages.parse(..., output_format=Model)` → `parsed_output` (or `output_config.format`) |
| Agent Framework | `agent.run(prompt, options={"response_format": Model})` → `response.value` |
| Semantic Kernel | `PromptExecutionSettings(response_format=Model)` in `KernelArguments`, then `Model.model_validate_json(...)` |
| AutoGen | `AssistantAgent(output_content_type=Model)` → `StructuredMessage.content` |
| LangChain | `llm.with_structured_output(Model)`; in an agent `create_agent(response_format=Model)` |
| LangGraph | a node calling `llm.with_structured_output(Model)`, written into typed state |
| CrewAI | `Task(output_pydantic=Model)` → `crew.kickoff().pydantic` |

### Defining a tool
Almost all build the schema from the function's type hints and docstring. Differences: the plain **OpenAI SDK** needs a JSON schema written (or built) by you; **Semantic Kernel** uses plugin classes with `@kernel_function`; **CrewAI** `@tool("name")`; **Claude** `@beta_tool`; **Agent Framework** `tool(fn)` (put argument descriptions in `Annotated[..., Field(description=...)]`); **AutoGen** takes plain functions; **OpenAI Agents** `function_tool(fn)`; **LangChain/LangGraph** `@tool` / `tool(parse_docstring=True)`.

### Who runs the tool loop
| You write it | The SDK runs it |
|---|---|
| OpenAI SDK; Claude manual loop; LangGraph (you build the graph: model node → `ToolNode` → back) | Claude `tool_runner`, OpenAI Agents `Runner.run`, Agent Framework `agent.run`, Semantic Kernel `FunctionChoiceBehavior.Auto()`, AutoGen `AssistantAgent` (`max_tool_iterations`), LangChain `create_agent`, CrewAI `crew.kickoff()` |

### MCP (here: a local server over stdio)
| SDK | How |
|---|---|
| OpenAI | No local MCP client: use the `mcp` package and forward calls yourself (its hosted MCP tool needs a public URL) |
| OpenAI Agents | `MCPServerStdio(params=...)` → `Agent(mcp_servers=[...])` |
| Claude | `async_mcp_tool(tool, mcp_client)` per tool; hosted servers via the Messages API **MCP connector** |
| Agent Framework | `MCPStdioTool(name, command, args, allowed_tools=[...])` in `tools=[...]` |
| Semantic Kernel | `MCPStdioPlugin(...)` as a plugin |
| AutoGen | `McpWorkbench(StdioServerParams(...))` → `AssistantAgent(workbench=...)` (**needs `mcp<2`**) |
| LangChain / LangGraph | `langchain-mcp-adapters`: `MultiServerMCPClient({...}).get_tools()` (async only) |
| CrewAI | `Agent(mcps=[MCPServerStdio(..., tool_filter=...)])` |

### Human approval before a tool runs
The single most important harness feature for anything that writes. Three styles:

| Style | SDKs |
|---|---|
| **Pause and resume** (the run stops, state is kept, a person answers later) | OpenAI Agents `needs_approval=True` → `result.interruptions`, `state.approve()`; Agent Framework `approval_mode="always_require"` → `user_input_requests`, `to_function_approval_response()`; LangChain `HumanInTheLoopMiddleware` + checkpointer, resume with `Command`; LangGraph `interrupt()` in a node + checkpointer |
| **A hook or filter** that can block the call | Semantic Kernel auto-function-invocation filter; CrewAI `@before_tool_call` |
| **Inside the tool** (no built-in feature) | OpenAI SDK (your loop), Claude SDK (gate in the tool function), AutoGen (in the function, or a `UserProxyAgent` team) |

Pause-and-resume is what you want for real approvals: the person may answer hours later, from another screen.

### Step limits
OpenAI Agents `max_turns`; Claude `max_iterations`; Agent Framework `function_invocation_configuration={"max_iterations": N}`; Semantic Kernel `maximum_auto_invoke_attempts`; AutoGen `max_tool_iterations` (**defaults to 1**) and termination conditions; LangChain `ModelCallLimitMiddleware`; LangGraph `recursion_limit`; CrewAI `max_iter`, `max_execution_time`; plain OpenAI: your loop.

### Multi-agent
| SDK | Pattern used here | Others available |
|---|---|---|
| OpenAI | Two calls chained in code | — |
| OpenAI Agents | Researcher **hands off** to writer (`handoffs=[...]`) | `agent.as_tool()` (manager keeps control) |
| Claude | Researcher run, then writer call | Managed Agents multi-agent workflows; Claude Agent SDK subagents |
| Agent Framework | `SequentialBuilder` | Concurrent, GroupChat, Handoff, Magentic builders; custom `WorkflowBuilder` graphs |
| Semantic Kernel | `SequentialOrchestration` | Concurrent, GroupChat, Handoff, Magentic |
| AutoGen | `RoundRobinGroupChat` | Selector, Magentic-One, Swarm |
| LangChain | Subagents as tools of a supervisor | — |
| LangGraph | A compiled agent graph inside an outer graph | Supervisor and swarm graphs |
| CrewAI | `Process.sequential` crew, task `context=[...]` | `Process.hierarchical`, Flows |

### Tracing
Agent Framework: middleware + OpenTelemetry + DevUI. Semantic Kernel and AutoGen: OpenTelemetry. OpenAI Agents: built-in tracing that exports **to OpenAI** by default (switch off or add your own processor on Azure). LangChain/LangGraph: LangSmith (account needed) or callbacks / `stream(stream_mode="updates")`. CrewAI: hooks and event bus; **telemetry on by default**. Claude: per-message `usage`, OpenTelemetry spans; plain OpenAI: none built in.

### Azure OpenAI with Entra sign-in (no keys)
| SDK | Parameter |
|---|---|
| OpenAI / OpenAI Agents | `base_url=f"{endpoint}/openai/v1/"`, `api_key=<token callable>` (async callable for `AsyncOpenAI`) |
| Agent Framework | `OpenAIChatCompletionClient(azure_endpoint=..., credential=DefaultAzureCredential())` |
| Semantic Kernel | `AzureChatCompletion(ad_token_provider=...)` |
| AutoGen | `AzureOpenAIChatCompletionClient(azure_ad_token_provider=..., model_info={...})` |
| LangChain / LangGraph | `AzureChatOpenAI(azure_ad_token_provider=...)` |
| CrewAI | no `api_key` + `credential_scopes=["https://cognitiveservices.azure.com/.default"]` (or 401 "audience is incorrect") |

## Gotchas worth knowing before an interview or a project
- **Agent Framework**: providers and orchestrations are separate packages; `MCPStdioTool` needs `tenacity`; `SequentialBuilder` returns only the last agent unless `output_from="all"`.
- **AutoGen**: archived; its MCP module breaks on the MCP SDK 2.x; unknown model names need `model_info`; `max_tool_iterations` defaults to 1.
- **Semantic Kernel**: orchestrations need `protobuf`; the approval filter only runs if the agent is given that kernel.
- **OpenAI Agents SDK**: traces go to OpenAI by default; approval is a saved state you resume, not a callback.
- **LangChain/LangGraph**: approvals need a checkpointer and a `thread_id`; an interrupted node re-runs from its start on resume, so put side effects after `interrupt()`.
- **CrewAI**: telemetry is on by default (`CREWAI_DISABLE_TELEMETRY=true`); `from __future__ import annotations` in tool modules breaks its schemas.
- **Claude SDK**: tool results must be text or content blocks, not dicts; set `effort` explicitly on Opus 5.5.
- **Multi-agent hand-offs lose facts**: in several SDKs the writer dropped the client's name until the writer's prompt asked for it, and one researcher added "on track" with no data behind it.

## Results (all five tasks, all eleven SDKs)

54 of 55 passed ([RESULTS.md](RESULTS.md)): the first nine SDKs in the run of 30 October 2026, Strands and PydanticAI on 13 November 2026.

| SDK | 01 structured | 02 tools | 03 MCP | 04 agent | 05 multi-agent |
|---|---|---|---|---|---|
| OpenAI | PASS | PASS | PASS | PASS | PASS |
| OpenAI Agents | PASS | PASS | PASS | PASS | PASS |
| Claude | PASS | PASS | PASS | PASS | PASS |
| Agent Framework | PASS | PASS | PASS | PASS | PASS |
| Semantic Kernel | PASS | PASS | PASS | PASS | PASS |
| AutoGen | PASS | PASS | PASS | PASS | PASS |
| LangChain | PASS | PASS | PASS | FAIL* | PASS |
| LangGraph | PASS | PASS | PASS | PASS | PASS |
| CrewAI | PASS | PASS | PASS | PASS | PASS |
| Strands | PASS | PASS | PASS | PASS | PASS |
| PydanticAI | PASS | PASS | PASS | PASS | PASS |

\* Not a LangChain fault: in about 1 run in 7, `gpt-5.4-mini` also logged a risk on ENG-101, which its own report said did not qualify. With `--auto-approve` the approval gate let it through; a person at the prompt would have seen "ENG-101" and refused. It can happen with any SDK on this model, and it is the clearest argument here for human approval on writes and for checking agents' actions in code.

## Which one?
- **Microsoft / Azure work**: Microsoft Agent Framework. Semantic Kernel and AutoGen code should plan a migration (Microsoft publishes guides for both).
- **Claude-first products**: the Claude SDK for API work; the Claude Agent SDK for a ready-made harness (file, shell and web tools, hooks, permissions, subagents); Managed Agents when Anthropic should host the loop and the sandbox.
- **Need every step explicit, resumable and auditable**: LangGraph (or Agent Framework workflows).
- **Quick agent with many integrations**: LangChain `create_agent`.
- **OpenAI-centred, handoff-style**: OpenAI Agents SDK.
- **Role-based pipelines fast**: CrewAI.
- **Full control, minimal dependencies**: the provider's own SDK and your own loop (as Lab 25 does).
