# Google Drive MCP server

**Which server.** The reference `gdrive` server in `modelcontextprotocol/servers` was archived. This example uses `google-drive-mcp` (npm 1.3.0, by domdomegg, listed in the MCP Registry as `io.github.domdomegg/google-drive-mcp`), a community server that is current. In stdio mode it reads a ready-made OAuth token from `GOOGLE_ACCESS_TOKEN`, which keeps the example simple. Google also runs its own remote Drive MCP endpoint, which needs a Google Cloud project with the MCP service enabled; it is not used here.

**Tools.** 23, including write tools (`file_upload`, `file_update`, `file_move`, `file_delete`, `folder_create`, comment and permission tools). Only `files_list`, `file_get` and `file_download` are on the allow-list, and the token should have only the `drive.readonly` scope, so a mistake cannot write. I confirmed the server starts and lists those 23 tools with a dummy token; no call reached Google.

**What it needs (SKIP without it).**
1. In https://console.cloud.google.com create (or pick) a project and enable the Google Drive API.
2. Under APIs & Services, OAuth consent screen: set it up as External, add yourself as a test user, add the scope `https://www.googleapis.com/auth/drive.readonly`.
3. Get a short-lived access token. Either use the OAuth 2.0 Playground (https://developers.google.com/oauthplayground, select Drive API v3 `drive.readonly`, authorise, exchange the code, copy the access token), or with the gcloud CLI: `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/cloud-platform` then `gcloud auth application-default print-access-token`.
4. `export GOOGLE_ACCESS_TOKEN=...` (it expires after about an hour), then `python examples/stack/run_all.py mcp-servers/google-drive`.

**How it does the task.** Claude searches with `files_list` (Drive query syntax) and names the five newest files. `run.py` runs the same listing itself and checks that a returned file name is in the answer.

**Limits.** The token is not refreshed; for a long-running setup use the server's HTTP mode, which does the OAuth flow with a client ID and secret. The full path was not run against a real Drive.

Ran on 2026-11-15: SKIP (no GOOGLE_ACCESS_TOKEN).
