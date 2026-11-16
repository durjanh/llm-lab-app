"""Slack MCP server: Claude lists the workspace's channels and reads one channel's recent history (read-only).

Runs @zencoderai/slack-mcp-server (pinned), the maintained fork of the archived reference server, over stdio with
npx. It needs SLACK_BOT_TOKEN and SLACK_TEAM_ID, so without them this prints SKIP after checking that the launch
parameters build. slack_post_message, slack_reply_to_thread and slack_add_reaction are never on the allow-list.
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

NAME = "mcp-servers/slack"
PACKAGE = "@zencoderai/slack-mcp-server@0.0.1"
READ_ONLY = {"slack_list_channels", "slack_get_channel_history", "slack_get_thread_replies", "slack_get_users",
             "slack_get_user_profile"}
TASK = "List the Slack channels, then read the latest messages of one of them. Name the channel and summarise its newest message."


async def main() -> None:
    from mcp import Client, StdioServerParameters

    bot, team = config.env("SLACK_BOT_TOKEN"), config.env("SLACK_TEAM_ID")
    params = StdioServerParameters(command="npx", args=["-y", PACKAGE], env={
        "SLACK_BOT_TOKEN": bot, "SLACK_TEAM_ID": team, "PATH": os.environ.get("PATH", "")})
    if not (bot and team):
        return checks.skip(NAME, "set SLACK_BOT_TOKEN and SLACK_TEAM_ID (steps in NOTES.md)")
    if not shutil.which("npx") or not config.HAS_CLAUDE:
        return checks.skip(NAME, "install Node 20+ and set ANTHROPIC_API_KEY")
    async with Client(params) as mcp:
        text, called = await shared.answer(mcp, TASK, READ_ONLY, "You read a Slack workspace.")
        listing = shared.text_of(await mcp.call_tool("slack_list_channels", {"limit": 20}))
    try:
        names = [c["name"] for c in json.loads(listing).get("channels", [])]
    except (ValueError, AttributeError, TypeError):
        names = []
    ok = "slack_list_channels" in called and "slack_get_channel_history" in called and any(n in text for n in names)
    checks.report(NAME, ok, f"read history of a channel ({len(names)} channels listed)" if ok else f"called {called}; answer {text[:120]!r}")


if __name__ == "__main__":
    asyncio.run(main())
