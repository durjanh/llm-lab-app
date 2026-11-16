# Agent SDK cheatsheet

Sixteen Python SDKs doing the same five tasks with the same tools, data and prompts (see [TASKS.md](TASKS.md)): structured output, function tools, the same tools over MCP, an autonomous agent with human approval before a write, and the SDK's own multi-agent pattern. Every example ran for real on 30 October 2026, on Azure OpenAI `gpt-5.4-mini` with Entra sign-in (no keys), except the Claude SDK, which used `claude-opus-5-5`. Strands Agents and PydanticAI were added on 13 November 2026 and ran on `claude-haiku-5-5` through their Anthropic providers. Agno, CAMEL, LlamaIndex and Google ADK were added on 15 November 2026 and ran on Azure OpenAI `gpt-5.4-mini` with Entra sign-in; AWS Bedrock Agents is written and dry-run only, because the lab machine has no AWS account. Exact versions are in each folder's `requirements.txt`; detail and gotchas in each `NOTES.md`.

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
| [Strands Agents](strands/) | 1.64 | AWS, active | Model-driven agent loop; hooks, graph, swarm | AWS estates; short agent code with hooks |
| [PydanticAI](pydantic-ai/) | 2.68 | Pydantic, active | Typed agents, deferred tools, graphs | Type-safe Python agents; approvals as data |
| [Agno](agno/) | 3.2 | Agno, active (formerly Phidata) | Agents, teams, workflows, plus an agent runtime | Fast agents and teams with built-in pause and resume |
| [CAMEL-AI](camel/) | 0.2.90 | CAMEL community, active | Agent societies: role-playing, workforce | Research on multi-agent behaviour; role-played task solving |
| [LlamaIndex](llamaindex/) | core 0.14 | LlamaIndex Inc, active | `FunctionAgent` plus event-driven `Workflow`s, with the data and RAG tools | Agents over your own data; custom event-driven flows |
| [Google ADK](google-adk/) | 2.14 | Google, active | Runner, sessions, workflow agents, built-in confirmation | Gemini and Google Cloud first; other models through LiteLLM |
| [Bedrock Agents](bedrock-agents/) | `boto3` 1.44 | AWS, active (**not run here**) | Managed agents with action groups and return of control, or Converse tool use | AWS estates that want the service to host the agent |

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
| Strands | `agent(prompt, structured_output_model=Model)` → `result.structured_output` |
| PydanticAI | `Agent(output_type=Model)` → `result.output` |
| Agno | `Agent(output_schema=Model)` → `run.content` |
| CAMEL | `agent.step(prompt, response_format=Model)` → `msgs[0].parsed` |
| LlamaIndex | `llm.as_structured_llm(Model).chat(...)` → `response.raw` |
| Google ADK | `LlmAgent(output_schema=Model)`; JSON text to validate yourself |
| Bedrock | Converse with a forced tool (`toolChoice`) whose schema is the model |

### Defining a tool
Almost all build the schema from the function's type hints and docstring. Differences: the plain **OpenAI SDK** needs a JSON schema written (or built) by you; **Semantic Kernel** uses plugin classes with `@kernel_function`; **CrewAI** `@tool("name")`; **Claude** `@beta_tool`; **Agent Framework** `tool(fn)` (put argument descriptions in `Annotated[..., Field(description=...)]`); **AutoGen** takes plain functions; **OpenAI Agents** `function_tool(fn)`; **LangChain/LangGraph** `@tool` / `tool(parse_docstring=True)`. **Strands** `tool(fn)`; **PydanticAI**, **Agno**, **LlamaIndex** and **Google ADK** take plain functions; **CAMEL** `FunctionTool(fn)`; **Bedrock** a `toolSpec` or an action group's `functionSchema`, which you write (the lab builds it from the type hints with pydantic).

### Who runs the tool loop
| You write it | The SDK runs it |
|---|---|
| OpenAI SDK; Claude manual loop; Bedrock Converse (you loop on `stopReason`); LangGraph (you build the graph: model node → `ToolNode` → back) | Claude `tool_runner`, OpenAI Agents `Runner.run`, Agent Framework `agent.run`, Semantic Kernel `FunctionChoiceBehavior.Auto()`, AutoGen `AssistantAgent` (`max_tool_iterations`), LangChain `create_agent`, CrewAI `crew.kickoff()`, Strands/PydanticAI/Agno/CAMEL/LlamaIndex/Google ADK (their agent or runner), Bedrock Agents (the service) |

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
| Strands | `MCPClient(lambda: stdio_client(params))`, then `mcp.list_tools_sync()` |
| PydanticAI | `MCPToolset(StdioTransport(...))` in `Agent(toolsets=[...])` |
| Agno | `MCPTools(command="...", exclude_tools=[...])` as an async context manager (needs `fastmcp`) |
| CAMEL | `MCPToolkit(config_dict={"mcpServers": {...}})` (**needs `mcp<2`**) |
| LlamaIndex | `McpToolSpec(BasicMCPClient(cmd, args=[...]), allowed_tools=[...])` → `to_tool_list_async()` |
| Google ADK | `McpToolset(connection_params=StdioConnectionParams(...), tool_filter=[...])` |
| Bedrock | no local MCP client: list tools with the `mcp` package, turn them into `toolSpec`s, forward calls |

### Human approval before a tool runs
The single most important harness feature for anything that writes. Three styles:

| Style | SDKs |
|---|---|
| **Pause and resume** (the run stops, state is kept, a person answers later) | OpenAI Agents `needs_approval=True` → `result.interruptions`, `state.approve()`; Agent Framework `approval_mode="always_require"` → `user_input_requests`, `to_function_approval_response()`; LangChain `HumanInTheLoopMiddleware` + checkpointer, resume with `Command`; LangGraph `interrupt()` in a node + checkpointer; PydanticAI `requires_approval` → `DeferredToolRequests`; Agno `requires_confirmation` → `run.active_requirements`, `continue_run`; Google ADK `require_confirmation` → `adk_request_confirmation`; LlamaIndex `InputRequiredEvent` / `HumanResponseEvent`; CAMEL external tools (you run the call and record the result); Bedrock Agents `RETURN_CONTROL` action group → `returnControl`, `returnControlInvocationResults` |
| **A hook or filter** that can block the call | Semantic Kernel auto-function-invocation filter; CrewAI `@before_tool_call`; Strands `BeforeToolCallEvent` hook (`cancel_tool`) |
| **Inside the tool** (no built-in feature) | OpenAI SDK (your loop), Claude SDK (gate in the tool function), AutoGen (in the function, or a `UserProxyAgent` team) |

Pause-and-resume is what you want for real approvals: the person may answer hours later, from another screen.

### Step limits
OpenAI Agents `max_turns`; Claude `max_iterations`; Agent Framework `function_invocation_configuration={"max_iterations": N}`; Semantic Kernel `maximum_auto_invoke_attempts`; AutoGen `max_tool_iterations` (**defaults to 1**) and termination conditions; LangChain `ModelCallLimitMiddleware`; LangGraph `recursion_limit`; CrewAI `max_iter`, `max_execution_time`; plain OpenAI: your loop; Strands: count calls in a hook (no setting); PydanticAI `UsageLimits`; Agno `tool_call_limit`; CAMEL `max_iteration`; LlamaIndex `run(max_iterations=)`; Google ADK `RunConfig(max_llm_calls=)`; Bedrock Agents: none, count the returns of control.

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
| Strands | `GraphBuilder` (researcher node → writer node) | Swarm, `agent.as_tool()` |
| PydanticAI | Writer agent calls the researcher agent as a tool | Programmatic hand-off, `pydantic-graph` |
| Agno | `Team` in coordinate mode | route, broadcast and tasks modes; `Workflow` |
| CAMEL | `Workforce` in pipeline mode | `RolePlaying`, auto-decomposing `Workforce` |
| LlamaIndex | A `Workflow`: a research step emits a `FactsEvent`, a write step handles it | `AgentWorkflow` hand-offs |
| Google ADK | `SequentialAgent` sharing state with `output_key` | `ParallelAgent`, `LoopAgent`, sub-agent transfer, `Workflow` |
| Bedrock | Two chained Converse agents (not run) | Multi-agent collaboration (supervisor and collaborators) |

### Tracing
Agent Framework: middleware + OpenTelemetry + DevUI. Semantic Kernel and AutoGen: OpenTelemetry. OpenAI Agents: built-in tracing that exports **to OpenAI** by default (switch off or add your own processor on Azure). LangChain/LangGraph: LangSmith (account needed) or callbacks / `stream(stream_mode="updates")`. CrewAI: hooks and event bus; **telemetry on by default**. Claude: per-message `usage`, OpenTelemetry spans; plain OpenAI: none built in. Strands: OpenTelemetry, hooks. PydanticAI: Logfire / OpenTelemetry, `event_stream_handler`. Agno: `tool_hooks`, stored runs. CAMEL: `ToolCallingRecord`s, AgentOps. LlamaIndex: the workflow event stream, instrumentation to Arize or Langfuse. Google ADK: every runner event, OpenTelemetry, `adk web`. Bedrock Agents: `enableTrace=True`.

### Azure OpenAI with Entra sign-in (no keys)
| SDK | Parameter |
|---|---|
| OpenAI / OpenAI Agents | `base_url=f"{endpoint}/openai/v1/"`, `api_key=<token callable>` (async callable for `AsyncOpenAI`) |
| Agent Framework | `OpenAIChatCompletionClient(azure_endpoint=..., credential=DefaultAzureCredential())` |
| Semantic Kernel | `AzureChatCompletion(ad_token_provider=...)` |
| AutoGen | `AzureOpenAIChatCompletionClient(azure_ad_token_provider=..., model_info={...})` |
| LangChain / LangGraph | `AzureChatOpenAI(azure_ad_token_provider=...)` |
| CrewAI | no `api_key` + `credential_scopes=["https://cognitiveservices.azure.com/.default"]` (or 401 "audience is incorrect") |
| Strands / PydanticAI | not used here (Claude on `claude-haiku-5-5`); both have OpenAI-compatible and Azure model classes |
| Agno | `AzureOpenAI(azure_endpoint=..., azure_deployment=..., azure_ad_token_provider=...)` |
| CAMEL | `ModelFactory.create(ModelPlatformType.AZURE, ..., azure_ad_token_provider=...)` |
| LlamaIndex | `AzureOpenAI(engine=..., azure_ad_token_provider=...)`; **subclass to drop `api_key`** with `openai` 3.x |
| Google ADK | `LiteLlm(model="azure/<deployment>", api_base=..., azure_ad_token_provider=...)` |
| Bedrock | not applicable (AWS's own models); AWS credentials instead of Entra |

## Gotchas worth knowing before an interview or a project
- **Agent Framework**: providers and orchestrations are separate packages; `MCPStdioTool` needs `tenacity`; `SequentialBuilder` returns only the last agent unless `output_from="all"`.
- **AutoGen**: archived; its MCP module breaks on the MCP SDK 2.x; unknown model names need `model_info`; `max_tool_iterations` defaults to 1.
- **Semantic Kernel**: orchestrations need `protobuf`; the approval filter only runs if the agent is given that kernel.
- **OpenAI Agents SDK**: traces go to OpenAI by default; approval is a saved state you resume, not a callback.
- **LangChain/LangGraph**: approvals need a checkpointer and a `thread_id`; an interrupted node re-runs from its start on resume, so put side effects after `interrupt()`.
- **CrewAI**: telemetry is on by default (`CREWAI_DISABLE_TELEMETRY=true`); `from __future__ import annotations` in tool modules breaks its schemas.
- **Claude SDK**: tool results must be text or content blocks, not dicts; set `effort` explicitly on Opus 5.5.
- **Agno**: `MCPTools` needs `fastmcp` installed separately; pause and resume is `run.active_requirements` plus `agent.continue_run(run)` in 3.x (older examples differ).
- **CAMEL**: needs `mcp<2` even to import its tools; a tool result cannot be handed back after an external tool call without a private method; `Workforce` is chatty and spends extra calls.
- **LlamaIndex**: its Azure LLM sends a token as both key and provider, which `openai` 3.x refuses (subclass and drop the key); a `Workflow` step that waits re-runs from its start.
- **Google ADK**: everything runs through a `Runner` and sessions; `SequentialAgent` is deprecated for `Workflow` in 2.x; confirmation arrives as an `adk_request_confirmation` function call.
- **Bedrock Agents**: needs an AWS account, model access and an IAM role for the agent; not run in this lab (dry runs only); no step limit on agents.
- **Multi-agent hand-offs lose facts**: in several SDKs the writer dropped the client's name until the writer's prompt asked for it, and one researcher added "on track" with no data behind it.

## Results (all five tasks, all sixteen SDKs)

74 of 75 runnable scripts passed (the one failure is LangChain's, below); the 5 Bedrock Agents scripts are SKIP, since the lab machine has no AWS account ([RESULTS.md](RESULTS.md)). The first nine SDKs ran on 30 October 2026, Strands and PydanticAI on 13 November, Agno, CAMEL, LlamaIndex and Google ADK on 15 November.

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
| Agno | PASS | PASS | PASS | PASS | PASS |
| CAMEL | PASS | PASS | PASS | PASS | PASS |
| LlamaIndex | PASS | PASS | PASS | PASS | PASS |
| Google ADK | PASS | PASS | PASS | PASS | PASS |
| Bedrock Agents | SKIP | SKIP | SKIP | SKIP | SKIP |

\* Not a LangChain fault: in about 1 run in 7, `gpt-5.4-mini` also logged a risk on ENG-101, which its own report said did not qualify. With `--auto-approve` the approval gate let it through; a person at the prompt would have seen "ENG-101" and refused. It can happen with any SDK on this model, and it is the clearest argument here for human approval on writes and for checking agents' actions in code.

## Which one?
- **Microsoft / Azure work**: Microsoft Agent Framework. Semantic Kernel and AutoGen code should plan a migration (Microsoft publishes guides for both).
- **Claude-first products**: the Claude SDK for API work; the Claude Agent SDK for a ready-made harness (file, shell and web tools, hooks, permissions, subagents); Managed Agents when Anthropic should host the loop and the sandbox.
- **Need every step explicit, resumable and auditable**: LangGraph (or Agent Framework workflows).
- **Quick agent with many integrations**: LangChain `create_agent`.
- **OpenAI-centred, handoff-style**: OpenAI Agents SDK.
- **Role-based pipelines fast**: CrewAI.
- **Custom event-driven flows over your own data**: LlamaIndex Workflows.
- **Gemini and Google Cloud**: Google ADK (it also reaches other models through LiteLLM).
- **Teams of agents with built-in pause and resume**: Agno.
- **AWS, service-hosted agents**: Bedrock Agents (written here, not run).
- **Full control, minimal dependencies**: the provider's own SDK and your own loop (as Lab 25 does).
