"""Tests for the engagements MCP server, through a real MCP client: in-process, and over HTTP with auth.

    python -m pytest examples/mcp -q
"""
from __future__ import annotations

import anyio
import pytest
from mcp import Client
from starlette.testclient import TestClient

from server import build_server, http_app, sample_store


def call(server, name: str, args: dict):
    async def go():
        async with Client(server) as client:
            return await client.call_tool(name, args)
    return anyio.run(go)


def listing(server):
    async def go():
        async with Client(server) as client:
            return (await client.list_tools()).tools
    return anyio.run(go)


def test_tools_are_described_for_the_model_and_marked_read_or_write() -> None:
    tools = {t.name: t for t in listing(build_server())}
    assert set(tools) == {"search_engagements", "get_engagement", "log_risk"}
    assert tools["search_engagements"].annotations.read_only_hint is True
    assert tools["log_risk"].annotations.read_only_hint is False and tools["log_risk"].annotations.idempotent_hint is True
    schema = tools["search_engagements"].input_schema["properties"]
    assert schema["status"]["enum"] == ["active", "closed", "all"] and schema["limit"]["maximum"] == 20
    assert tools["get_engagement"].output_schema is not None  # structured results


def test_search_is_paged_with_an_opaque_cursor() -> None:
    server = build_server()
    first = call(server, "search_engagements", {"status": "all", "limit": 2}).structured_content
    assert first["total"] == 4 and len(first["engagements"]) == 2 and first["next_cursor"]
    rest = call(server, "search_engagements", {"status": "all", "limit": 2, "cursor": first["next_cursor"]}).structured_content
    assert rest["next_cursor"] is None
    ids = [e["id"] for e in first["engagements"] + rest["engagements"]]
    assert sorted(ids) == ["ENG-090", "ENG-101", "ENG-104", "ENG-107"]
    bad = call(server, "search_engagements", {"cursor": "nonsense"})
    assert bad.is_error and "Start the search again" in bad.content[0].text


def test_errors_tell_the_model_what_to_do_next() -> None:
    result = call(build_server(), "get_engagement", {"engagement_id": "ENG-999"})
    assert result.is_error and "use search_engagements" in result.content[0].text
    invalid = call(build_server(), "search_engagements", {"limit": 500})
    assert invalid.is_error  # the input schema is enforced before the tool runs


def test_logging_a_risk_is_idempotent() -> None:
    store = sample_store()
    server = build_server(store)
    args = {"engagement_id": "eng-104", "title": "Key supplier may not renew on current terms",
            "severity": "high", "owner": "Priya Shah", "idempotency_key": "req-0001-abcd"}
    first = call(server, "log_risk", args).structured_content
    again = call(server, "log_risk", args).structured_content  # e.g. a retry after a timeout
    assert first["created"] is True and again["created"] is False and again["risk"]["id"] == first["risk"]["id"]
    assert len(store.engagements["ENG-104"].risks) == 2
    closed = call(server, "log_risk", {**args, "engagement_id": "ENG-090", "idempotency_key": "req-0002-abcd"})
    assert closed.is_error and "closed" in closed.content[0].text


def test_the_brief_resource_and_the_prompt() -> None:
    async def go():
        async with Client(build_server()) as client:
            brief = await client.read_resource("engagement://ENG-101/brief")
            prompt = await client.get_prompt("weekly_update", {"engagement_id": "ENG-101"})
            return brief.contents[0].text, prompt.messages[0].content.text
    brief, prompt = anyio.run(go)
    assert brief.startswith("# Northgate Builders") and "RISK-1 (high)" in brief
    assert "get_engagement" in prompt and "ENG-101" in prompt


def test_the_catalogue_resource_lists_every_engagement_without_a_search() -> None:
    async def go():
        async with Client(build_server()) as client:
            listed = await client.list_resources()
            catalogue = await client.read_resource("engagement://catalogue")
            return [str(r.uri) for r in listed.resources], catalogue.contents[0].text
    uris, catalogue = anyio.run(go)
    assert "engagement://catalogue" in uris
    assert catalogue.startswith("# Engagements (4)")
    for engagement_id in ("ENG-090", "ENG-101", "ENG-104", "ENG-107"):  # closed ones too
        assert f"- {engagement_id} (" in catalogue
    assert "Northgate Builders" in catalogue and "RISK-" not in catalogue  # summaries only, not the full records


# --- Over HTTP, as a hosted server -------------------------------------------------------------

RPC = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
       "MCP-Protocol-Version": "2025-06-18"}


def rpc(client: TestClient, token: str | None, method: str, params: dict) -> tuple[int, dict]:
    headers = {**RPC, **({"Authorization": f"Bearer {token}"} if token else {})}
    r = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    return r.status_code, (r.json() if r.headers.get("content-type", "").startswith("application/json") else {})


@pytest.fixture
def hosted():
    app = http_app("http://testserver/mcp", "https://auth.example.com",
                   "reader=engagements:read;writer=engagements:read engagements:write", ["testserver"])
    with TestClient(app) as client:
        yield client


def test_http_needs_a_token_and_the_write_scope_to_write(hosted: TestClient) -> None:
    status, _ = rpc(hosted, None, "tools/list", {})
    assert status == 401
    status, _ = rpc(hosted, "wrong", "tools/list", {})
    assert status == 401

    args = {"engagement_id": "ENG-104", "title": "Contract data arrives late from the client",
            "severity": "low", "owner": "Sarah Mitchell", "idempotency_key": "http-0001-abcd"}
    status, body = rpc(hosted, "reader", "tools/call", {"name": "log_risk", "arguments": args})
    assert status == 200 and body["result"]["isError"] is True
    assert "engagements:write" in body["result"]["content"][0]["text"]

    status, body = rpc(hosted, "writer", "tools/call", {"name": "log_risk", "arguments": args})
    assert status == 200 and body["result"]["isError"] is False
    assert body["result"]["structuredContent"]["created"] is True

    status, body = rpc(hosted, "reader", "tools/call", {"name": "get_engagement", "arguments": {"engagement_id": "ENG-104"}})
    risks = body["result"]["structuredContent"]["engagement"]["risks"]
    assert any(r["title"] == "Contract data arrives late from the client" for r in risks)  # the write is visible
