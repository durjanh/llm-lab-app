# MCP server example: engagements

A small Model Context Protocol server, and the three ways Claude uses one. The server looks after a consulting team's engagements: search them, read one, log a risk. It's written to show the design decisions, not the domain.

| File | What it is |
|---|---|
| `server.py` | The MCP server: 3 tools, 1 resource, 1 prompt. stdio for local use; Streamable HTTP with bearer-token scopes when hosted |
| `test_server.py` | Tests through a real MCP client, in-process and over HTTP with auth |
| `ask_claude.py` | Claude API + your harness: starts the server over stdio, and asks a person before any write |
| `remote_connector.py` | Claude API, MCP connector: Anthropic's servers call your hosted server, allowlisted to read tools |
| `dot-mcp.json` | Claude Code: copy to `.mcp.json` at the project root |

```sh
pip install -r examples/mcp/requirements.txt
python -m pytest examples/mcp -q                      # 6 tests
python examples/mcp/ask_claude.py                     # Claude answers from the server's data
python examples/mcp/ask_claude.py --task "Log a high risk on Brightwater: legal is on leave until December. Priya owns it."
```

## Three ways to connect Claude

| | Who runs the MCP client | Transport | Use it for |
|---|---|---|---|
| **Claude Code** | Claude Code | stdio (local) or HTTP (hosted) | Developers' own tools; ship it in a plugin |
| **Your harness** (`ask_claude.py`) | Your code, with the SDK's `async_mcp_tool` | Usually stdio | Your own agent, where you control approvals, logging and retries |
| **MCP connector** (`remote_connector.py`) | Anthropic's servers | Streamable HTTP, public HTTPS | No MCP client in your code; the server must be reachable from the internet |

In Claude Code, `.mcp.json` registers the server for everyone working in the repo. You can also add it from the command line:

```sh
claude mcp add engagements -- python examples/mcp/server.py
claude mcp add --transport http engagements-hosted https://mcp.example.com/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

A plugin can carry the same `.mcp.json` at its root, so installing the plugin installs the server together with its skills and commands.

## Design decisions

**Tools are for the model, so design them like an API for a new colleague.**
- Few tools, each a whole task (`get_engagement`, not `get_budget` + `get_dates` + `get_risks`). Every tool's name, description and schema goes into Claude's context on every request, and similar tools get confused with each other.
- Descriptions say when to use the tool and what comes back, and the argument docs give examples ("Ids look like ENG-104").
- Constrained inputs (`Literal`, `ge`/`le`, lengths) are enforced by the SDK before your code runs, so the model gets a clear error instead of you handling bad input.
- Structured results (pydantic models) give the model clean JSON and give clients an output schema.

**Keep results small.** Search returns summaries, not whole records; the detail is one call away. Results are paged with an opaque `next_cursor`, so the paging scheme can change later without breaking clients.

**Errors are instructions.** A `ToolError` reaches the model as `is_error` with your message: say what went wrong *and what to do next* ("use search_engagements to find the right one"; "do not retry"). Any other exception reaches it only as a generic failure.

**Say what changes data, and make writes safe to retry.**
- Annotations (`read_only_hint`, `destructive_hint`, `idempotent_hint`) let a client ask a person before a write. `ask_claude.py` does that in the harness, where the model can't skip it.
- `log_risk` takes an idempotency key, so a call retried after a timeout returns the first risk instead of adding a second.
- In production, have the harness supply the key rather than the model.

**Resources and prompts are for the person, tools for the model.** The brief (`engagement://ENG-101/brief`) is data a user attaches. `weekly_update` is a starting message they pick, which shows up as a slash command in Claude Code.

**Hosted: stateless HTTP, authentication on every request.**
- `stateless_http=True` with JSON responses means any instance can answer any request, so it scales behind a load balancer (AWS ALB with ECS Fargate, or Lambda) with nothing stored in memory between calls. Move the data to a real database first.
- Tokens are checked on every request, and scopes decide what each caller may do: `engagements:read` reads, `engagements:write` writes.
- `validate_token_resource=True` refuses tokens issued for another server (audience binding), so a token can't be replayed across MCP servers.
- DNS-rebinding protection limits the accepted `Host` headers.

## Taking it to production

- **Auth:** replace `StaticTokens` with a JWT verifier for your identity provider (Amazon Cognito, Entra ID, Okta). Check the signature against the JWKS, the expiry, the audience (this server's URL) and the scopes; only `verify_token` changes. For people connecting from Claude, use the MCP authorization flow (OAuth 2.1 with PKCE, discovered from the server's protected-resource metadata, which the SDK serves).
- **Least privilege downstream:** the server calls your systems with its own narrowly scoped credentials (an IAM role, or a secret from Secrets Manager), never with the user's token passed through.
- **Treat tool output as untrusted** if it contains text from outside (emails, documents, web pages). It can carry prompt injection, so keep writes behind approval.
- **Operations:** log each tool call with the caller, arguments, duration and result size, plus a request id; rate-limit per token; set timeouts on downstream calls; alert on error rates.
- **Versioning:** add tools and optional arguments freely. Renaming or removing them breaks clients and the prompts that rely on them, so deprecate first.
- **Evals:** a small set of real tasks ("which engagements are over 80% of budget?"), checked for the right tool calls and answer, catches regressions from description changes.

The SDK used here is the MCP Python SDK 2.x (`mcp.server.mcpserver.MCPServer`; in 1.x it was `FastMCP`).
