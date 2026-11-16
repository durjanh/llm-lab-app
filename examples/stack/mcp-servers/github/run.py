"""GitHub's official MCP server: Claude reads a repository's README heading and its latest commit message.

Runs ghcr.io/github/github-mcp-server (pinned tag) in Docker over stdio with GITHUB_READ_ONLY=1 and only the "repos"
toolset. The token comes from GITHUB_TOKEN, GITHUB_PERSONAL_ACCESS_TOKEN or `gh auth token`, is handed to the container
through its environment and is never printed or written.
"""
import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/mcp-servers
from common import checks, config  # noqa: E402
import shared  # noqa: E402

NAME = "mcp-servers/github"
IMAGE = "ghcr.io/github/github-mcp-server:v2.1.0"
REPO = ("durjanh", "llm-lab-app")
READ_ONLY = {"get_file_contents", "list_commits", "get_commit"}
TASK = (f"On the GitHub repository {REPO[0]}/{REPO[1]}: what is the first heading in README.md, and what is the message "
        "of the latest commit on the default branch? Reply as JSON with the keys heading and commit_message.")


def token() -> str:
    for name in ("GITHUB_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"):
        if config.env(name):
            return config.env(name)
    try:
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=15)
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


async def main() -> None:
    from mcp import Client, StdioServerParameters

    tok = token()
    if not tok:
        return checks.skip(NAME, "set GITHUB_TOKEN (or run `gh auth login`)")
    if not config.HAS_CLAUDE:
        return checks.skip(NAME, "set ANTHROPIC_API_KEY")
    if not shared.docker_ready():
        return checks.skip(NAME, "start Docker (the server runs from the image " + IMAGE + ")")
    params = StdioServerParameters(
        command="docker",
        args=["run", "-i", "--rm", "--name", "stack-mcp-servers-github", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
              "-e", "GITHUB_READ_ONLY=1", "-e", "GITHUB_TOOLSETS=repos", IMAGE, "stdio"],
        env={"GITHUB_PERSONAL_ACCESS_TOKEN": tok, "PATH": os.environ.get("PATH", "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin")})
    async with Client(params) as mcp:
        text, called = await shared.answer(mcp, TASK, READ_ONLY, "You read GitHub repositories.")
        # The expected values come from the GitHub API directly, through the same read-only server.
        readme = shared.text_of(await mcp.call_tool("get_file_contents", {"owner": REPO[0], "repo": REPO[1], "path": "README.md"}))
        commits = shared.text_of(await mcp.call_tool("list_commits", {"owner": REPO[0], "repo": REPO[1], "perPage": 1}))
    heading = next((m.group(1).strip() for m in re.finditer(r"^#\s+(.+)$", readme, re.M)), "")
    try:
        subject = json.loads(commits)[0]["commit"]["message"].splitlines()[0]
    except (ValueError, KeyError, IndexError, TypeError):
        subject = ""
    norm = lambda s: re.sub(r"\W+", " ", s).lower().strip()
    ok = bool(heading and subject) and norm(heading) in norm(text) and norm(subject) in norm(text) and bool(called)
    checks.report(NAME, ok, f"heading {heading!r} and latest commit found" if ok else f"expected {heading!r} / {subject!r}; got {text[:150]!r}")


if __name__ == "__main__":
    asyncio.run(main())
