"""The official MCP Registry: query its public REST API (v0) for 'postgres' and 'github' servers.

No server runs and no key is needed. It prints name, version and transport for the first matches of each search, then
checks that GitHub's own server (io.github.github/github-mcp-server, the one the github example runs) is listed.
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
from common import checks  # noqa: E402

NAME = "mcp-servers/registry"
API = "https://registry.modelcontextprotocol.io/v0/servers"
GITHUB_SERVER = "io.github.github/github-mcp-server"


def search(term: str, limit: int = 30) -> list[dict]:
    """The latest version of each server whose name matches the term."""
    url = f"{API}?{urllib.parse.urlencode({'search': term, 'version': 'latest', 'limit': limit})}"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=30) as r:
        return [s["server"] for s in json.load(r)["servers"]]


def transports(server: dict) -> str:
    found = {p.get("transport", {}).get("type", "?") + "/" + p.get("registryType", "?") for p in server.get("packages", [])}
    found |= {r["type"] + "/remote" for r in server.get("remotes", [])}
    return ", ".join(sorted(found)) or "none listed"


def main() -> None:
    try:
        results = {term: search(term) for term in ("postgres", "github")}
        exact = search(GITHUB_SERVER, 5)
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        return checks.report(NAME, False, f"the registry query failed: {e}") and None
    for term, servers in results.items():
        print(f"\n'{term}': {len(servers)} servers (first 6)")
        for s in servers[:6]:
            print(f"  {s['name']:55} {s['version']:10} {transports(s)}")
    github = next((s for s in exact if s["name"] == GITHUB_SERVER), None)
    if github:
        print(f"\nGitHub's server: {github['name']} {github['version']} ({transports(github)})")
    ok = bool(results["postgres"]) and bool(results["github"]) and github is not None
    checks.report(NAME, ok, f"{len(results['postgres'])} postgres and {len(results['github'])} github servers; "
                  f"{GITHUB_SERVER} {github['version'] if github else 'not found'}")


if __name__ == "__main__":
    main()
