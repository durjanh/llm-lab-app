"""The MCP lab: the example engagements server (examples/mcp/server.py), hosted inside the backend.

Two doors onto the same data:
- /api/mcp-lab/mcp is the server's real Streamable HTTP endpoint, with bearer tokens and scopes,
  so the page can send raw MCP requests and show exactly what goes over the wire.
- ask() is a small harness: Claude gets the server's tools, connected in-process, and any tool the
  server does not mark read-only runs only when the page allowed writes.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from typing import Any

import anyio
from mcp import Client
from mcp.server.auth.settings import AuthSettings
from mcp.server.transport_security import TransportSecuritySettings

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import ROOT, cost_usd
from .spend import SpendTracker

SERVER_FILE = ROOT / "examples" / "mcp" / "server.py"
PATH = "/api/mcp-lab"
# Demo tokens, shown on the page: this server only ever holds sample data.
TOKENS = {"demo-read": "engagements:read", "demo-write": "engagements:read engagements:write"}
SYSTEM = "You help a consulting delivery team. Use the engagement tools; never guess figures. Be brief."
MAX_TURNS = 8


def load_example() -> Any:
    """examples/mcp/server.py, imported by path: the lab runs the very file the README describes."""
    if str(SERVER_FILE.parent) not in sys.path:
        sys.path.insert(0, str(SERVER_FILE.parent))  # server.py imports its data module, engagements_data, from beside it
    spec = importlib.util.spec_from_file_location("engagements_mcp", SERVER_FILE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class McpLab:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, origin: str, allowed_hosts: set[str]):
        self.claude, self.spend = claude, spend
        self.example = load_example()
        self.store = self.example.sample_store()
        self.url = f"{origin}{PATH}/mcp"
        auth = AuthSettings(issuer_url="https://auth.example.com", resource_server_url=self.url,
                            required_scopes=["engagements:read"], validate_token_resource=True)
        tokens = ";".join(f"{t}={s}" for t, s in TOKENS.items())
        hosted = self.example.build_server(self.store, auth=auth, token_verifier=self.example.StaticTokens(tokens, self.url))
        self.app = hosted.streamable_http_app(
            streamable_http_path="/mcp", stateless_http=True, json_response=True,
            # DNS-rebinding protection: only this server's own hosts, and pages served from them.
            transport_security=TransportSecuritySettings(allowed_hosts=sorted(allowed_hosts),
                                                         allowed_origins=sorted(f"http://{h}" for h in allowed_hosts)))
        self.local = self.example.build_server(self.store)  # the same data, for the harness, in-process

    def info(self) -> dict[str, Any]:
        return {"url": f"{PATH}/mcp", "tokens": TOKENS}

    def reset(self) -> dict[str, Any]:
        """Back to the sample data. The servers keep their reference to the store, so it changes in place."""
        fresh = self.example.sample_store()
        self.store.engagements, self.store.by_key, self.store.next_risk = fresh.engagements, fresh.by_key, fresh.next_risk
        return {"ok": True}

    def ask(self, task: str, model: str, allow_writes: bool) -> dict[str, Any]:
        """Claude answers using the server's tools. Returns every step, for the page to show."""
        return anyio.run(self._ask, task, model, allow_writes)

    async def _ask(self, task: str, model: str, allow_writes: bool) -> dict[str, Any]:
        steps: list[dict[str, Any]] = []
        cost = 0.0
        async with Client(self.local) as mcp:
            listed = (await mcp.list_tools()).tools
            read_only = {t.name for t in listed if t.annotations and t.annotations.read_only_hint}
            tools = [{"name": t.name, "description": t.description or "", "input_schema": t.input_schema} for t in listed]
            messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
            for _ in range(MAX_TURNS):
                try:
                    response = await anyio.to_thread.run_sync(lambda: self.claude.create(
                        model=model, max_tokens=4000, system=SYSTEM, tools=tools, messages=messages))
                except Exception as exc:
                    raise to_api_error(exc) from exc
                self.spend.charge(response, model)
                cost += cost_usd(response.usage, model) or 0
                messages.append({"role": "assistant", "content": response.content})
                calls = [b for b in response.content if b.type == "tool_use"]
                text = "".join(b.text for b in response.content if b.type == "text").strip()
                if response.stop_reason == "refusal":
                    raise ApiError(422, "refused", "Claude declined this request.")
                if not calls:
                    steps.append({"kind": "answer", "text": text})
                    break
                if text:
                    steps.append({"kind": "say", "text": text})
                results = []
                for call in calls:
                    if call.name not in read_only and not allow_writes:
                        out, is_error = "A person declined this call (writes are not allowed). Do not retry it.", True
                        steps.append({"kind": "call", "tool": call.name, "input": call.input, "declined": True,
                                      "result": out, "is_error": True})
                    else:
                        r = await mcp.call_tool(call.name, call.input)
                        is_error = bool(r.is_error)
                        out = (json.dumps(r.structured_content) if r.structured_content is not None and not is_error
                               else "".join(getattr(c, "text", "") for c in r.content))
                        steps.append({"kind": "call", "tool": call.name, "input": call.input, "declined": False,
                                      "result": out, "is_error": is_error, "writes": call.name not in read_only})
                    results.append({"type": "tool_result", "tool_use_id": call.id, "content": out, "is_error": is_error})
                messages.append({"role": "user", "content": results})
            else:
                steps.append({"kind": "answer", "text": "(Stopped after the maximum number of steps.)"})
        return {"steps": steps, "cost": round(cost, 5), "spent_usd": round(self.spend.spent_usd, 4)}
