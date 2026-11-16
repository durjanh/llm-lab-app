"""Google Drive MCP server: Claude searches Drive for files and reports what it finds (read-only).

Runs google-drive-mcp (domdomegg, pinned) over stdio with npx. It needs a Google OAuth access token with the
drive.readonly scope in GOOGLE_ACCESS_TOKEN, so without one this prints SKIP (steps in NOTES.md). Only files_list,
file_get and file_download are on the allow-list; upload, update, move, trash, delete, comment and permission tools never are.
"""
import asyncio
import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/mcp-servers
from common import checks, config  # noqa: E402
import shared  # noqa: E402

NAME = "mcp-servers/google-drive"
PACKAGE = "google-drive-mcp@1.3.0"
READ_ONLY = {"files_list", "file_get", "file_download"}
TASK = "Search my Google Drive for the five most recently modified files and give their names."


async def main() -> None:
    from mcp import Client, StdioServerParameters

    token = config.env("GOOGLE_ACCESS_TOKEN")
    params = StdioServerParameters(command="npx", args=["-y", PACKAGE], env={
        "GOOGLE_ACCESS_TOKEN": token, "PATH": os.environ.get("PATH", "")})
    if not token:
        return checks.skip(NAME, "set GOOGLE_ACCESS_TOKEN to an OAuth token with the drive.readonly scope (steps in NOTES.md)")
    if not shutil.which("npx") or not config.HAS_CLAUDE:
        return checks.skip(NAME, "install Node 20+ and set ANTHROPIC_API_KEY")
    async with Client(params) as mcp:
        text, called = await shared.answer(mcp, TASK, READ_ONLY, "You search a person's Google Drive.")
        listing = shared.text_of(await mcp.call_tool(
            "files_list", {"pageSize": 5, "orderBy": "modifiedTime desc", "fields": "files(id,name)"}))
    try:
        names = [f["name"] for f in json.loads(listing).get("files", [])]
    except (ValueError, AttributeError, TypeError):
        names = []
    ok = "files_list" in called and (any(n in text for n in names) if names else bool(text.strip()))
    checks.report(NAME, ok, f"searched Drive ({len(names)} files)" if ok else f"called {called}; answer {text[:120]!r}")


if __name__ == "__main__":
    asyncio.run(main())
