# Slack MCP server

**Which server.** The reference `@modelcontextprotocol/server-slack` was archived and is deprecated on npm. `@zencoderai/slack-mcp-server` (0.0.1, MIT) is Zencoder's maintained fork of it, with the same tools and the same environment variables, so this example uses it. Slack also has its own hosted MCP server (`https://mcp.slack.com/mcp`) that signs in with OAuth through a registered Slack app; it needs an approved app and a browser sign-in, so it is not used here.

**Tools.** The server offers 8: `slack_list_channels`, `slack_get_channel_history`, `slack_get_thread_replies`, `slack_get_users`, `slack_get_user_profile` (read) and `slack_post_message`, `slack_reply_to_thread`, `slack_add_reaction` (write). Only the five read tools are on the allow-list. I confirmed the server starts and lists these 8 tools with a dummy token; no call reached Slack.

**What it needs (SKIP without it).**
1. Go to https://api.slack.com/apps and create an app "From scratch" in your workspace.
2. Under OAuth & Permissions, add Bot Token Scopes `channels:read`, `channels:history`, `users:read` (add `groups:read` and `groups:history` for private channels). Do not add `chat:write`.
3. Install the app to the workspace and copy the Bot User OAuth Token (`xoxb-...`).
4. Invite the bot to a channel (`/invite @yourapp`) so it has history to read.
5. Find the Team ID (starts with `T`) from the workspace URL in the web client, or from `auth.test`.
6. `export SLACK_BOT_TOKEN=... SLACK_TEAM_ID=...` (or put them in the lab's `.env`), then `python examples/stack/run_all.py mcp-servers/slack`.

**How it does the task.** Claude lists channels, reads the history of one, and names the channel and its newest message. `run.py` passes only if both tools were called and the answer names a channel that `slack_list_channels` returned.

**Limits.** Version 0.0.1 is the only one published and has had no release since July 2025. It lists only public channels unless `SLACK_CHANNEL_IDS` is set. The full path was not run against a real workspace.

Ran on 2026-11-15: SKIP (no SLACK_BOT_TOKEN or SLACK_TEAM_ID).
