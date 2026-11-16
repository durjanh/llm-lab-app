# MCP servers

An MCP server gives a model tools it can call. Each example here starts (or connects to) one real server, lists its tools, lets Claude (`claude-haiku-5-5`) answer one task through them with a short tool loop, and checks the answer. The loop is in `shared.py`: it uses the Anthropic SDK and the MCP Python SDK (2.x) client.

**Read-only only.** Each `run.py` has an allow-list of tool names. Only those tools are shown to the model, and a call to any other name is refused in the loop before it reaches the server. Servers that have a read-only mode are also started in it.

| Folder | Server (pinned) | Transport | Task | Needs |
|---|---|---|---|---|
| `filesystem/` | `@modelcontextprotocol/server-filesystem@2.3.0` (npx) | stdio | Answer 3 gold questions by reading the handbook as 12 Markdown files | Node 20+, Claude key |
| `postgres/` | `crystaldba/postgres-mcp:0.3.0` (Docker), `--access-mode=restricted` | stdio | "Which section mentions extension 4400?" by SQL on database `stack_mcp` | Docker, the lab's `llm-lab-pgvector` on :5433, Claude key |
| `github/` | `ghcr.io/github/github-mcp-server:v2.1.0` (Docker), `GITHUB_READ_ONLY=1`, toolset `repos` | stdio | Read `durjanh/llm-lab-app`'s README heading and latest commit message | Docker, a GitHub token, Claude key |
| `slack/` | `@zencoderai/slack-mcp-server@0.0.1` (npx) | stdio | List channels, read one channel's history | `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID` (else SKIP) |
| `google-drive/` | `google-drive-mcp@1.3.0` (npx) | stdio | Search Drive for recent files | `GOOGLE_ACCESS_TOKEN` (else SKIP) |
| `registry/` | the official MCP Registry REST API (v0) | HTTPS | Search 'postgres' and 'github'; check GitHub's server is listed | Internet only |

Each folder also has a `.mcp.json` showing how to add the same server to Claude Code, and a `NOTES.md`.

## How to run

```sh
cd examples/stack/mcp-servers/<tool>
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd ../../../.. && python examples/stack/run_all.py mcp-servers      # all six, writes examples/stack/RESULTS.md
python examples/stack/run_all.py mcp-servers/github                 # one
```

The last line of each run is `PASS`, `FAIL` or `SKIP` (see `../CONVENTIONS.md`). The GitHub token is `GITHUB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN` or `gh auth token`, read at run time and passed to the container through its environment; it is never printed or written. `postgres/` creates the database `stack_mcp` in the lab's container and drops it at the end. Containers are named `stack-mcp-servers-<tool>` and are removed when the run ends.

## Security note

An MCP server runs with your permissions and your tokens. A filesystem server can read everything you point it at, a database server can run whatever SQL its role allows, and a GitHub or Slack server acts as you. A model that reads untrusted text (an issue, a message, a document) can be steered into calling tools you did not intend.

- Prefer read-only modes (`--access-mode=restricted`, `GITHUB_READ_ONLY=1`) and narrow toolsets.
- Allow-list tool names in the client, as `shared.py` does, instead of trusting the server's list.
- Give each server the least access it needs: one folder, one database, a token with read scopes only.
- Pin versions (and image tags or digests), and read what a server does before you run it: it is code you are executing.
