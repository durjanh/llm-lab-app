"""The MCP lab: the example server hosted in the backend, called over real HTTP, and Claude using its tools."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace as NS
from typing import Any

import pytest
from anthropic.types import Message
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.settings import Settings
from backend.tests.test_api import LAB

RPC = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
       "MCP-Protocol-Version": "2025-06-18", "host": "localhost:8000"}


def reply(content: list[dict], stop: str) -> Message:
    return Message.model_validate({"id": "msg_test", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
                                   "content": content, "stop_reason": stop, "stop_sequence": None,
                                   "usage": {"input_tokens": 500, "output_tokens": 50}})


class ScriptedClaude:
    """Asks for the given tool calls on its first turn, then answers."""

    def __init__(self, calls: list[tuple[str, dict]]):
        self.calls, self.requests = calls, []

    def create(self, **params: Any) -> Message:
        self.requests.append({**params, "messages": list(params["messages"])})  # as sent, before later turns
        if len(self.requests) == 1:
            return reply([{"type": "tool_use", "id": f"t{i}", "name": n, "input": a} for i, (n, a) in enumerate(self.calls)],
                         "tool_use")
        return reply([{"type": "text", "text": "Done."}], "end_turn")


def lab(tmp_path: Path, claude: ScriptedClaude | None = None) -> TestClient:
    messages = claude or ScriptedClaude([])
    fake = NS(messages=messages, beta=NS(messages=messages), models=NS(retrieve=lambda m: {"id": m}))
    settings = Settings(port=8000, frontend_dist=tmp_path, models_dir=tmp_path / "none", sites_dir=tmp_path / "sites")
    return TestClient(create_app(settings, client=fake, browser=NS(available=False)), base_url="http://localhost:8000")


def rpc(client: TestClient, token: str | None, method: str, params: dict) -> Any:
    headers = {**RPC, **({"Authorization": f"Bearer {token}"} if token else {})}
    return client.post("/api/mcp-lab/mcp", headers=headers,
                       json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})


def test_the_hosted_server_speaks_mcp_with_tokens_and_scopes(tmp_path: Path) -> None:
    with lab(tmp_path) as client:
        assert client.get("/api/mcp-lab/info", headers=LAB).json()["tokens"]["demo-read"] == "engagements:read"
        anonymous = rpc(client, None, "tools/list", {})
        assert anonymous.status_code == 401 and "resource_metadata" in anonymous.headers["www-authenticate"]
        tools = rpc(client, "demo-read", "tools/list", {}).json()["result"]["tools"]
        assert {t["name"] for t in tools} == {"search_engagements", "get_engagement", "log_risk"}
        args = {"engagement_id": "ENG-104", "title": "Legal team on leave until December", "severity": "high",
                "owner": "Priya Shah", "idempotency_key": "page-0001-abcd"}
        refused = rpc(client, "demo-read", "tools/call", {"name": "log_risk", "arguments": args}).json()["result"]
        assert refused["isError"] and "engagements:write" in refused["content"][0]["text"]
        logged = rpc(client, "demo-write", "tools/call", {"name": "log_risk", "arguments": args}).json()["result"]
        assert logged["structuredContent"]["created"] is True
        client.post("/api/mcp-lab/reset", headers=LAB)
        detail = rpc(client, "demo-read", "tools/call", {"name": "get_engagement", "arguments": {"engagement_id": "ENG-104"}})
        assert len(detail.json()["result"]["structuredContent"]["engagement"]["risks"]) == 1  # back to the sample


@pytest.mark.parametrize("allow", [False, True])
def test_claude_uses_the_tools_and_writes_only_when_allowed(tmp_path: Path, allow: bool) -> None:
    claude = ScriptedClaude([
        ("get_engagement", {"engagement_id": "ENG-101"}),
        ("log_risk", {"engagement_id": "ENG-101", "title": "Audit may slip past January", "severity": "high",
                      "owner": "Tom Hughes", "idempotency_key": "ask-0001-abcd"}),
    ])
    with lab(tmp_path, claude) as client:
        r = client.post("/api/mcp-lab/ask", headers=LAB, json={"task": "Check ENG-101 and log the audit risk",
                                                                "allow_writes": allow})
        assert r.status_code == 200, r.text
        steps = r.json()["steps"]
        read, write = steps[0], steps[1]
        assert read["tool"] == "get_engagement" and not read["is_error"] and "Northgate" in read["result"]
        assert write["declined"] is (not allow) and write["is_error"] is (not allow)
        assert steps[-1] == {"kind": "answer", "text": "Done."}
        # Claude saw the server's own tool schemas, and got both results back in one message
        assert {t["name"] for t in claude.requests[0]["tools"]} == {"search_engagements", "get_engagement", "log_risk"}
        results = claude.requests[1]["messages"][-1]["content"]
        assert [x["type"] for x in results] == ["tool_result", "tool_result"]
        assert r.json()["cost"] > 0
