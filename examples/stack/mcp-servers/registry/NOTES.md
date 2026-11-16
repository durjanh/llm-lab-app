# The official MCP Registry

`registry.modelcontextprotocol.io` is the MCP project's public catalogue of servers. Its REST API (v0) needs no key: `GET /v0/servers?search=<text>&version=latest&limit=<n>` returns `{servers: [{server: {name, version, packages, remotes, ...}}]}`. Each entry says how to run the server: `packages` (npm, PyPI, OCI image, with stdio or HTTP transport and the environment variables it needs) and `remotes` (hosted Streamable HTTP endpoints).

**How it does the task.** `run.py` (standard library only) searches 'postgres' and 'github', prints name, version and transport for the first six of each, and then looks up `io.github.github/github-mcp-server`, the server the `github/` example runs. PASS needs both searches to return servers and that entry to be listed.

**Surprises.** Without `version=latest` the API returns every version of a name (GitHub's server appears about 30 times, 0.16.0 to 2.1.0). `search` matches names as substrings, so 'postgres' returns many unrelated stack generators; the registry is open to anyone who can prove a namespace, so it is a directory, not a vetted list. Check who publishes a server before you run it. The registry's 2.1.0 matches the image tag pinned in `github/`. Nothing here is an MCP server, so `.mcp.json` shows the remote GitHub endpoint that the registry entry advertises.

Ran on 2026-11-15: PASS, 30 postgres and 30 github servers; io.github.github/github-mcp-server 2.1.0.
