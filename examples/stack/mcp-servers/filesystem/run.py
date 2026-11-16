"""Filesystem MCP server: Claude reads the handbook's Markdown files to answer three gold questions.

Starts @modelcontextprotocol/server-filesystem (pinned) over stdio, confined to a temp folder holding the 12 sections.
Only read tools are on the allow-list; write_file, edit_file, move_file and create_directory are never offered.
"""
import asyncio
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/mcp-servers
from common import checks, config, data  # noqa: E402
import shared  # noqa: E402

NAME = "mcp-servers/filesystem"
PACKAGE = "@modelcontextprotocol/server-filesystem@2.3.0"
READ_ONLY = {"read_text_file", "read_file", "read_multiple_files", "list_directory", "list_directory_with_sizes",
             "directory_tree", "search_files", "get_file_info", "list_allowed_directories"}


async def main() -> None:
    from mcp import Client, StdioServerParameters

    if not shutil.which("npx"):
        return checks.skip(NAME, "install Node 20+ (npx runs the server)")
    if not config.HAS_CLAUDE:
        return checks.skip(NAME, "set ANTHROPIC_API_KEY")
    folder = Path(tempfile.mkdtemp(prefix="stack-mcp-fs-")).resolve()
    try:
        for title, text in data.SECTIONS:
            (folder / f"{data._slug(title)}.md").write_text(f"# {title}\n\n{text}\n")
        params = StdioServerParameters(command="npx", args=["-y", PACKAGE, str(folder)])
        results = []
        async with Client(params) as mcp:
            for gold in data.GOLD[:3]:
                print(f"Q: {gold.question}")
                text, called = await shared.answer(
                    mcp, gold.question, READ_ONLY,
                    f"The handbook is a folder of Markdown files, one per section, in {folder}.")
                results.append(gold.correct(text) and bool(called))
        checks.report(NAME, all(results), f"{checks.score(results)} answers correct")
    finally:
        shutil.rmtree(folder, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
