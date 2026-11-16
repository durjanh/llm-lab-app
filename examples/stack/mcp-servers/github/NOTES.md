# GitHub MCP server

GitHub's official server, `github/github-mcp-server` (Go). The latest in the MCP Registry is 2.1.0 and the image `ghcr.io/github/github-mcp-server:v2.1.0` is pinned. It also has a hosted remote at `https://api.githubcopilot.com/mcp/` (Streamable HTTP, needs a token); this example runs the image over stdio so nothing leaves the machine except the GitHub API calls.

**Read-only.** `GITHUB_READ_ONLY=1` removes every write tool, and `GITHUB_TOOLSETS=repos` leaves 13 repository tools. The allow-list narrows that to `get_file_contents`, `list_commits` and `get_commit`.

**Token.** `GITHUB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, or `gh auth token`, read in `run.py` and put in the container's environment (`-e GITHUB_PERSONAL_ACCESS_TOKEN`, no value on the command line). It is not printed or stored. Without one the run prints SKIP. A token that can read the repository is enough.

**How it does the task.** Claude calls `get_file_contents` for `README.md` and `list_commits` with `perPage: 1`, then answers as JSON. `run.py` fetches the same two things itself and checks that the heading and the commit's first line appear in the answer.

**Surprises.** File contents come back as an embedded resource, not as text, so `shared.text_of` reads both. The registry also lists versions 0.16 to 0.30 for the same name; version 2.1.0 is the newest. The latest commit on GitHub is whatever has been pushed, which can be behind the local checkout.

Ran on 2026-11-15: PASS, heading 'LLM Lab' and latest commit found.
