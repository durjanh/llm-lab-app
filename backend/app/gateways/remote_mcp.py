"""Remote MCP servers over Streamable HTTP, for the assistant page: list a server's tools and call one.

Each call opens its own short session (a list or a call is one connection), so nothing is kept open between turns and
a server that goes away is noticed at the next use. The token goes only to that server, as `Authorization: Bearer`;
proxies from the environment are not used, and the SDK follows a redirect only within the server's own origin.

Every connection goes to the address that was checked (PinnedTransport), not to whatever the name resolves to a moment
later, so a name that answers with a public address for the check and a forbidden one for the connection (DNS
rebinding) cannot reach the forbidden one. The Host header and the TLS server name stay the server's name.
"""
from __future__ import annotations

import base64
from typing import Any, Protocol

import anyio
import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

TIMEOUT_S = 30.0


class RemoteMcp(Protocol):
    def list_tools(self, url: str, token: str | None, address: str | None = None) -> list[dict[str, Any]]: ...
    def call_tool(self, url: str, token: str | None, name: str, args: dict[str, Any],
                  address: str | None = None) -> dict[str, Any]: ...


class PinnedTransport(httpx2.AsyncBaseTransport):
    """Sends every request for `host` to `address`, the address that passed the checks, keeping the Host header and
    the TLS server name (SNI) as `host`. A request for any other host is refused."""

    def __init__(self, host: str, address: str, inner: httpx2.AsyncBaseTransport | None = None):
        self.host, self.address = host.lower().rstrip("."), address
        self.inner = inner or httpx2.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        if (request.url.host or "").lower().rstrip(".") != self.host:
            raise httpx2.ConnectError(f"Only {self.host} may be reached from this connection.", request=request)
        request.url = request.url.copy_with(host=self.address)  # the Host header was set from the name already
        request.extensions = {**request.extensions, "sni_hostname": self.host}
        return await self.inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self.inner.aclose()


class StreamableHttpMcp:
    """The real client: the mcp package's Client over its Streamable HTTP transport."""

    def __init__(self, timeout_s: float = TIMEOUT_S):
        self.timeout_s = timeout_s

    def _client(self, url: str, token: str | None, address: str | None) -> tuple[Client, httpx2.AsyncClient]:
        host = httpx2.URL(url).host
        http = httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"} if token else None,
                                  timeout=self.timeout_s, trust_env=False,
                                  transport=PinnedTransport(host, address) if address else None)
        return Client(streamable_http_client(url, http_client=http), read_timeout_seconds=self.timeout_s), http

    def list_tools(self, url: str, token: str | None, address: str | None = None) -> list[dict[str, Any]]:
        async def run() -> list[dict[str, Any]]:
            client, http = self._client(url, token, address)
            async with http:
                with anyio.fail_after(self.timeout_s):
                    async with client as session:
                        tools = (await session.list_tools()).tools
            return [{"name": t.name, "description": t.description or "", "input_schema": t.input_schema or {}}
                    for t in tools]
        return anyio.run(run)

    def call_tool(self, url: str, token: str | None, name: str, args: dict[str, Any],
                  address: str | None = None) -> dict[str, Any]:
        """The result as {"text": ..., "images": [{media_type, data}], "is_error": bool}."""
        async def run() -> dict[str, Any]:
            client, http = self._client(url, token, address)
            async with http:
                with anyio.fail_after(self.timeout_s):
                    async with client as session:
                        r = await session.call_tool(name, args)
            texts, images = [], []
            for c in r.content or []:
                kind = getattr(c, "type", "")
                if kind == "text":
                    texts.append(c.text)
                elif kind == "image":
                    images.append({"media_type": c.mime_type, "data": c.data})
                elif kind == "audio":
                    texts.append(f"[audio, {getattr(c, 'mime_type', '')}, not shown]")
                else:  # a resource or a link: its text or its address
                    resource = getattr(c, "resource", None)
                    texts.append(getattr(resource, "text", None) or str(getattr(c, "uri", "") or getattr(resource, "uri", "")))
            if not texts and r.structured_content is not None:
                import json
                texts.append(json.dumps(r.structured_content, ensure_ascii=False))
            return {"text": "\n".join(texts), "images": images, "is_error": bool(r.is_error)}
        return anyio.run(run)


def image_block(image: dict[str, Any]) -> dict[str, Any] | None:
    """An image from a tool result as a Messages image block, when it is a kind the model reads."""
    if image.get("media_type") not in ("image/png", "image/jpeg", "image/gif", "image/webp"):
        return None
    try:
        base64.b64decode(image.get("data") or "", validate=True)
    except ValueError:
        return None
    return {"type": "image", "source": {"type": "base64", "media_type": image["media_type"], "data": image["data"]}}
