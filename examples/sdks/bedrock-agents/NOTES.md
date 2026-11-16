# AWS Bedrock Agents (boto3)
- Package(s) and version: `boto3` 1.44.3 (`bedrock-runtime` Converse, `bedrock-agent`, `bedrock-agent-runtime`); `mcp` 2.3.0 for task 3 only
- Status: AWS's managed agent service (Bedrock Agents, with AgentCore for hosting and tooling). Used here through boto3 only, not the Strands SDK (there is a Strands folder) or the AgentCore SDK.
- Model and sign-in used here: none, this machine has no AWS account. The code uses a Claude model on Bedrock (`BEDROCK_MODEL_ID`, default `us.anthropic.claude-haiku-4-5-20251001-v1:0`; check the id and your model access in your region) and the standard AWS credential chain (`AWS_PROFILE` or keys, `AWS_REGION`). Bedrock does not serve Azure OpenAI, and the lab's Claude key is for Anthropic's own API, so Claude on Bedrock is the only model that fits.

## Cheatsheet
| Concept | How in this SDK (short code or API names) |
|---|---|
| Structured output | Converse with a forced tool: `toolConfig={"tools": [...], "toolChoice": {"tool": {"name": ...}}}`, read `toolUse.input`, validate with pydantic |
| Define a tool | a `toolSpec` with a JSON schema (built here from the type hints with pydantic's `TypeAdapter`); for agents, a `functionSchema` on an action group |
| Tool loop | Converse: you write it (`stopReason == "tool_use"`, send `toolResult`, repeat); Bedrock Agents: the service runs it |
| MCP | no client for local servers: the `mcp` package lists tools, they become `toolSpec`s, calls go back to the server |
| Human approval before a tool | an action group with `actionGroupExecutor={"customControl": "RETURN_CONTROL"}`: `invoke_agent` returns a `returnControl` event, the caller runs (or refuses) the call and replies with `sessionState.returnControlInvocationResults` |
| Step limit / stop | none on an agent; count the returns of control. Converse: your loop |
| Multi-agent | multi-agent collaboration (a supervisor agent with collaborators, `agentCollaboration`); here two chained Converse calls |
| Tracing / observability | `enableTrace=True` on `invoke_agent` streams the reasoning and tool trace; CloudWatch |
| Azure OpenAI with Entra | not applicable: Bedrock is AWS's own model service |

## Gotchas found while building this
- It could not be run here. Every script checks for `AWS_PROFILE` or `AWS_ACCESS_KEY_ID` (and that boto3 finds credentials) and prints `SKIP <task>: needs an AWS account with Bedrock model access (set AWS_PROFILE and AWS_REGION)`, then exits 0.
- `--dry-run` builds the first request with throwaway credentials and checks it against botocore's own API model, without any network. `python _bedrock.py --self-test` does the same for the whole agent flow (create agent, action group, prepare, alias, invoke, return of control, delete). The dry run found real mistakes (a one-character session id). It checks shapes, not behaviour: nothing here has talked to Bedrock.
- A Bedrock agent needs an IAM role it can assume (`BEDROCK_AGENT_ROLE_ARN`), and creating, preparing and aliasing it takes tens of seconds. `04_agent.py` creates its own agent and deletes it at the end.
- With return of control, Bedrock sends tool arguments as strings (`{"name", "type", "value"}`), so the script passes them through as given; the shared functions accept them.
- The Converse API rejects an empty tool list, so the writer call in task 5 leaves `toolConfig` out.
- Bedrock multi-agent collaboration would need a deployed alias and Lambda action groups for each collaborator, so task 5 chains two Converse agents in code instead.

## Results
Not run: all five tasks print `SKIP` on this machine (see [RESULTS.md](../RESULTS.md)). The dry runs and the offline Converse loop check (a fake client answering one tool call) pass.
