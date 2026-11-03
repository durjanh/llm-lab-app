# LangGraph
- Package(s) and version: langgraph 1.2.18 (langgraph-checkpoint 4.3.1, langgraph-prebuilt 1.1.1), langchain-core 1.7.3, langchain-openai 1.7.3, langchain-mcp-adapters 0.3.2
- Status: maintained by LangChain Inc; actively developed. The low-level runtime underneath LangChain's agents (durable execution, checkpoints, interrupts); `create_react_agent` from langgraph.prebuilt is superseded by LangChain's `create_agent`, so here the loop is written as a graph.
- Model and sign-in used here: Azure OpenAI `gpt-5.4-mini` via `AzureChatOpenAI(azure_ad_token_provider=...)` (Entra, no key)

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | A node calls `llm.with_structured_output(Triage)` and writes the result into the typed state |
| Define a tool | Same as LangChain: `@tool` / `tool(parse_docstring=True)(fn)`; `model.bind_tools(tools)` in the model node |
| Tool loop | You build it: `StateGraph(MessagesState)`, nodes `model` and `tools` (`ToolNode`), `add_conditional_edges("model", tools_condition)`, edge `tools -> model` |
| MCP | langchain-mcp-adapters `MultiServerMCPClient(...).get_tools()`, passed to `ToolNode` and `bind_tools`; `ainvoke` |
| Human approval before a tool | A `review` node between model and tools calls `interrupt({...})` per write call; compile with a checkpointer; resume with `invoke(Command(resume=answer), config)`; the node returns `Command(goto=...)` to route |
| Step limit / stop | `recursion_limit` in the run config (`GraphRecursionError` when reached) |
| Multi-agent | Compose graphs: a compiled agent graph runs inside a node of an outer `StateGraph` (here researcher -> writer); supervisor/swarm patterns are also graphs |
| Tracing / observability | LangSmith, LangGraph Studio; `graph.get_graph().draw_mermaid()` prints the graph; `stream(stream_mode="updates")` for step-by-step events |
| Azure OpenAI with Entra | Same chat model as LangChain: `AzureChatOpenAI(..., azure_ad_token_provider=...)` |

## Gotchas found while building this
- An interrupted node re-runs from its start on resume; earlier `interrupt()` calls in it return their saved answers, so put side effects after the interrupts, not before.
- `invoke(..., version="v2")` returns `GraphOutput` with `.value` and `.interrupts`; the old `result["__interrupt__"]` style is deprecated.
- When a node routes with `Command(goto=...)`, declare `destinations=` in `add_node` so the graph (and its drawing) knows the edges.
- `draw_ascii()` needs the extra `grandalf` package; `draw_mermaid()` needs nothing.
- Everything LangChain's middleware gives you (approval, limits, tracing) is explicit here: more code, but every step is visible and checkpointed.

## Results
| Task | Result | Time |
|---|---|---|
| 01_structured | PASS | 3.5s |
| 02_tools | PASS | 5.6s |
| 03_mcp | PASS | 7.7s |
| 04_agent (`--auto-approve`) | PASS: one risk on ENG-107; declining at the prompt logs nothing and the agent says so | 6.8s |
| 05_multi_agent | PASS | 2.9s |
