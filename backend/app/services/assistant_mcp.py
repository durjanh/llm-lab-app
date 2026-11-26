"""The assistant's remote MCP servers: the person adds them in the page, and every agent in a turn can use their tools.

Kept in generated/assistant/mcp.json, written with file mode 600 because it holds tokens. A token is sent only to its
own server, as `Authorization: Bearer`; it is never returned to the page, written to a log or an event, shown to the
model or passed to the sandbox. The page sees `token_set` instead.

A URL must be http or https, with no user name or password in it, and must not reach a link-local address
(169.254.0.0/16, fe80::/10) or a cloud metadata host. localhost is allowed (the lab's own MCP server runs there), but not
this backend's own ports, so a server cannot point the backend at its own API. The host is resolved again before every
connection, so a name that later resolves somewhere forbidden is refused then.

Tool names and descriptions come from the server and are untrusted text: the page shows them, the log records each
tool's description the first time a turn uses it, and the model is told that tool output is data. Each tool appears to
the model as mcp__<server slug>__<tool>, with the server's own input schema.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from ..core.errors import ApiError
from ..gateways.remote_mcp import RemoteMcp

REFRESHED = ("tools", "status", "message", "checked_at")  # what connecting and listing again changes
MAX_SERVERS = 20
MAX_TOOLS_PER_TURN = 100
MAX_NAME = 60
MAX_URL = 2000
MAX_TOKEN = 8000
ID = re.compile(r"^[0-9a-f]{12}$")
METADATA_HOSTS = {"metadata.google.internal", "metadata", "metadata.azure.com", "instance-data", "instance-data.ec2.internal"}
METADATA_IPS = {ipaddress.ip_address(a) for a in ("169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254",
                                                  "168.63.129.16")}
LINK_LOCAL = [ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("fe80::/10")]
NAT64 = [ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("64:ff9b:1::/48")]


def embedded(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> list[Any]:
    """The address and any IPv4 address carried inside it (IPv4-mapped, 6to4, Teredo, NAT64), each of which must pass
    the checks: ::ffff:169.254.169.254 is the metadata address however it is written."""
    out: list[Any] = [ip]
    if ip.version == 6:
        if ip.ipv4_mapped:
            out.append(ip.ipv4_mapped)
        if ip.sixtofour:
            out.append(ip.sixtofour)
        if ip.teredo:
            out.extend(ip.teredo)
        if any(ip in net for net in NAT64):
            out.append(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    return out
TOOL_NAME = re.compile(r"[^a-zA-Z0-9_-]")


def resolve(host: str) -> list[str]:
    """The addresses a host name resolves to, or the address itself."""
    try:
        return [ipaddress.ip_address(host.strip("[]")).compressed]
    except ValueError:
        pass
    return sorted({info[4][0] for info in socket.getaddrinfo(host, None)})


def slug(name: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:20] or "server"
    out, n = base, 2
    while out in taken:
        out, n = f"{base[:17]}_{n}", n + 1
    return out


class McpServers:
    """The servers, their tools as last listed, and the checks every URL must pass."""

    def __init__(self, path: Path, client: RemoteMcp, own_ports: set[int],
                 resolver: Callable[[str], list[str]] = resolve):
        self.path, self.client, self.own_ports, self.resolver = Path(path), client, own_ports, resolver
        self._lock = threading.RLock()

    # ----- storage (mode 600: it holds tokens) -----
    def _read(self) -> list[dict[str, Any]]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8")).get("servers", [])
        except FileNotFoundError:
            return []
        except ValueError:
            return []  # a damaged file: start empty rather than fail every page

    def _write(self, servers: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".mcp.{uuid.uuid4().hex[:6]}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"servers": servers}, f, ensure_ascii=False, indent=1)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def all(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._read()

    def get(self, server_id: str) -> dict[str, Any]:
        found = next((s for s in self.all() if s["id"] == server_id), None) if ID.match(server_id or "") else None
        if found is None:
            raise ApiError(404, "not_found", "No such MCP server.")
        return found

    @staticmethod
    def public(s: dict[str, Any]) -> dict[str, Any]:
        """A server as the page sees it: never its token, never its tools' schemas."""
        return {"id": s["id"], "name": s["name"], "url": s["url"], "enabled": s["enabled"],
                "ask_before_call": s["ask_before_call"], "token_set": bool(s.get("token")),
                "status": s.get("status", "unchecked"), "message": s.get("message", ""),
                "checked_at": s.get("checked_at"),
                "tools": [{"name": t["name"], "description": t.get("description", "")} for t in s.get("tools", [])]}

    # ----- the URL rules -----
    def check_url(self, url: str) -> str:
        return self.vet(url)[0]

    def vet(self, url: str) -> tuple[str, str]:
        """The URL and the address to connect to: every address the host resolves to must pass, and the connection is
        then pinned to the first, so it cannot be re-resolved somewhere else (DNS rebinding)."""
        url = (url or "").strip()
        if not url or len(url) > MAX_URL:
            raise ApiError(400, "invalid_request", "Give the server's URL.")
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ApiError(400, "invalid_request", "The URL must start with http:// or https:// and name a host.")
        if parts.username or parts.password:
            raise ApiError(400, "invalid_request", "Put a token in the token field, not in the URL.")
        host = parts.hostname.lower().rstrip(".")
        if host in METADATA_HOSTS:
            raise ApiError(400, "invalid_request", "Cloud metadata addresses are not allowed.")
        try:
            port = parts.port or (443 if parts.scheme == "https" else 80)
        except ValueError:
            raise ApiError(400, "invalid_request", "The URL's port is not a number.") from None
        try:
            addresses = self.resolver(host)
        except OSError:
            raise ApiError(400, "invalid_request", f"{host} could not be found.") from None
        if not addresses:
            raise ApiError(400, "invalid_request", f"{host} could not be found.")
        for a in addresses:
            for ip in embedded(ipaddress.ip_address(a.split("%")[0])):
                if ip in METADATA_IPS or any(ip in net for net in LINK_LOCAL):
                    raise ApiError(400, "invalid_request", "Link-local and cloud metadata addresses are not allowed.")
                if ip.is_unspecified or ip.is_multicast:
                    raise ApiError(400, "invalid_request", "That address cannot be an MCP server.")
                if ip.is_loopback and port in self.own_ports:
                    raise ApiError(400, "invalid_request", "That is this lab's own server. Use the lab's MCP server's "
                                                           "own address instead.")
        return url, addresses[0]

    # ----- changes -----
    def add(self, name: str, url: str, token: str | None, ask_before_call: bool) -> dict[str, Any]:
        name = " ".join((name or "").split())[:MAX_NAME]
        if not name:
            raise ApiError(400, "invalid_request", "Give the server a name.")
        url = self.check_url(url)
        token = self._token(token)
        with self._lock:
            if len(self._read()) >= MAX_SERVERS:
                raise ApiError(400, "invalid_request", f"At most {MAX_SERVERS} MCP servers.")
        server = {"id": uuid.uuid4().hex[:12], "name": name, "url": url, "token": token or "", "enabled": True,
                  "ask_before_call": bool(ask_before_call), "status": "unchecked", "message": "", "checked_at": None,
                  "tools": []}
        self._refresh(server, raise_on_error=True)
        with self._lock:
            servers = self._read()
            if len(servers) >= MAX_SERVERS:
                raise ApiError(400, "invalid_request", f"At most {MAX_SERVERS} MCP servers.")
            servers.append(server)
            self._write(servers)
        return server

    def update(self, server_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        current = self.get(server_id)
        fields: dict[str, Any] = {}
        if changes.get("name") is not None:
            fields["name"] = " ".join(changes["name"].split())[:MAX_NAME]
            if not fields["name"]:
                raise ApiError(400, "invalid_request", "Give the server a name.")
        if changes.get("url") is not None:
            fields["url"] = self.check_url(changes["url"])
        if changes.get("token") is not None:  # "" clears it
            fields["token"] = self._token(changes["token"]) or ""
        for key in ("enabled", "ask_before_call"):
            if changes.get(key) is not None:
                fields[key] = bool(changes[key])
        if fields.get("url", current["url"]) != current["url"] or fields.get("token", current.get("token")) != current.get("token"):
            fresh = {**current, **fields}
            self._refresh(fresh, raise_on_error=False)  # a new address or token: list the tools again (no lock held)
            fields.update({k: fresh[k] for k in REFRESHED})
        return self._merge(server_id, fields)

    def delete(self, server_id: str) -> None:
        self.get(server_id)
        with self._lock:
            self._write([s for s in self._read() if s["id"] != server_id])

    def check(self, server_id: str) -> dict[str, Any]:
        server = dict(self.get(server_id))
        self._refresh(server, raise_on_error=False)
        return self._merge(server_id, {k: server[k] for k in REFRESHED})

    def mark(self, server_id: str, status: str, message: str) -> None:
        """Records how the server did at its last use (a call that failed in a turn), without its tools changing."""
        with self._lock:
            servers = self._read()
            for s in servers:
                if s["id"] == server_id:
                    s.update(status=status, message=message[:500], checked_at=time.time())
            self._write(servers)

    def _merge(self, server_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        """Writes only `fields` onto the server as it is stored now, under the lock, so a change made meanwhile (a
        mark() from a turn, another edit) is kept rather than overwritten by an older copy."""
        with self._lock:
            servers = self._read()
            found = next((s for s in servers if s["id"] == server_id), None)
            if found is None:
                raise ApiError(404, "not_found", "No such MCP server.")
            found.update(fields)
            self._write(servers)
            return dict(found)

    @staticmethod
    def _token(token: str | None) -> str | None:
        if token is None:
            return None
        token = token.strip()
        if len(token) > MAX_TOKEN or any(c in token for c in "\r\n"):
            raise ApiError(400, "invalid_request", "That token is not valid.")
        return token

    def _refresh(self, server: dict[str, Any], *, raise_on_error: bool) -> None:
        """Connects and lists the tools, recording the outcome. On add, a server that cannot be listed is refused."""
        try:
            url, address = self.vet(server["url"])
            tools = self.client.list_tools(url, server.get("token") or None, address)
            server.update(tools=[{"name": str(t["name"])[:200], "description": str(t.get("description") or "")[:2000],
                                  "input_schema": t.get("input_schema") or {}} for t in tools],
                          status="ok", message="", checked_at=time.time())
        except ApiError:
            raise
        except Exception as exc:  # noqa: BLE001  (unreachable, refused, not an MCP server)
            message = describe(exc, server.get("token"))
            if raise_on_error:
                raise ApiError(400, "invalid_request", f"The server could not be reached or listed: {message}") from None
            server.update(status="error", message=message, checked_at=time.time())

    # ----- a turn's tools -----
    def tools_for(self, server_ids: list[str]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], list[str]]:
        """The tools of the chat's enabled servers as model tool definitions, a map from each tool's model name to
        its server and tool, and notes on anything left out (over the per-turn limit)."""
        servers = [s for s in self.all() if s["id"] in server_ids and s["enabled"]]
        defs: list[dict[str, Any]] = []
        names: dict[str, dict[str, Any]] = {}
        notes: list[str] = []
        taken: set[str] = set()
        for s in servers:
            server_slug = slug(s["name"], taken)
            taken.add(server_slug)
            for t in s.get("tools", []):
                if len(defs) >= MAX_TOOLS_PER_TURN:
                    notes.append(f"Only the first {MAX_TOOLS_PER_TURN} MCP tools are offered; the rest are left out.")
                    return defs, names, notes
                tool_name = TOOL_NAME.sub("_", f"mcp__{server_slug}__{t['name']}")[:64]
                if tool_name in names:
                    continue
                schema = t.get("input_schema") if isinstance(t.get("input_schema"), dict) else {}
                if schema.get("type") != "object":
                    schema = {"type": "object", "properties": {}}
                defs.append({"name": tool_name, "description": f"[MCP server {s['name']}] {t.get('description', '')}"[:1024],
                             "input_schema": schema})
                names[tool_name] = {"server_id": s["id"], "server": s["name"], "tool": t["name"],
                                    "description": t.get("description", ""), "ask": s["ask_before_call"]}
        return defs, names, notes

    def call(self, server_id: str, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        """Calls a tool from the backend (never the sandbox), re-checking the URL first."""
        s = self.get(server_id)
        url, address = self.vet(s["url"])  # resolved and checked again, then the connection is pinned to it
        try:
            return self.client.call_tool(url, s.get("token") or None, tool, args, address)
        except Exception as exc:  # noqa: BLE001  (the server failed): the message, never the token
            raise McpCallFailed(describe(exc, s.get("token"))) from None


class McpCallFailed(Exception):
    """The server could not be reached or failed the call; the message holds no token."""


def describe(exc: BaseException, token: str | None) -> str:
    """An exception as text a person can act on, with the token removed if a library echoed it."""
    text = f"{type(exc).__name__}: {exc}"[:500]
    if isinstance(exc, BaseExceptionGroup):
        inner = exc.exceptions[0] if exc.exceptions else exc
        text = f"{type(inner).__name__}: {inner}"[:500]
    return text.replace(token, "[token]") if token else text
