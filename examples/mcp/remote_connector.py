"""The Claude API connects to a hosted MCP server itself: the MCP connector (beta).

No MCP client in your code: Anthropic's servers call the MCP server's URL during the request,
so it must be reachable on the public internet over HTTPS (deploy server.py --http, or put a
tunnel in front of it while developing). The toolset is an allowlist: only the read tools are
switched on here, so this integration cannot write even though the server offers log_risk.

    MCP_URL=https://mcp.example.com/mcp MCP_TOKEN=dev-read python remote_connector.py
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import anthropic

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
from common import describe_usage, fallback_params, make_client  # noqa: E402

MCP_BETA = "mcp-client-2025-11-20"


def request(args: argparse.Namespace, url: str, token: str | None, extra: dict):
    return make_client().beta.messages.create(
        model=args.model,
        max_tokens=16000,
        betas=[MCP_BETA, *extra.pop("betas", [])],
        **extra,
        mcp_servers=[{"type": "url", "url": url, "name": "engagements",
                      **({"authorization_token": token} if token else {})}],
        tools=[{
            "type": "mcp_toolset",
            "mcp_server_name": "engagements",
            "default_config": {"enabled": False},  # allowlist: nothing unless listed below
            "configs": {"search_engagements": {"enabled": True}, "get_engagement": {"enabled": True}},
        }],
        messages=[{"role": "user", "content": args.task}],
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--task", default="Summarise the active engagements and their open risks.")
    parser.add_argument("--model", default="claude-opus-5-5")
    args = parser.parse_args()
    url, token = os.environ.get("MCP_URL"), os.environ.get("MCP_TOKEN")
    if not url:
        raise SystemExit("Set MCP_URL to the server's public https address, and MCP_TOKEN to a token it accepts.")

    extra = dict(fallback_params(args.model))  # a copy: request() takes its betas out
    try:
        response = request(args, url, token, extra)
    except anthropic.BadRequestError as exc:  # e.g. the MCP server could not be reached from Anthropic
        raise SystemExit(f"The API refused the request: {exc.message}") from None
    if response.stop_reason == "refusal":
        raise SystemExit("The request was declined.")
    for block in response.content:
        if block.type == "mcp_tool_use":
            print(f"  tool call on {block.server_name}: {block.name}({block.input})")
        elif block.type == "mcp_tool_result":
            print(f"  result{' (error)' if block.is_error else ''}")
        elif block.type == "text" and block.text.strip():
            print(f"\n{block.text.strip()}\n")
    print(f"[stop_reason={response.stop_reason} · {describe_usage(response.usage, args.model)}]")


if __name__ == "__main__":
    main()
