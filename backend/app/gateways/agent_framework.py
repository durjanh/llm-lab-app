"""Microsoft Agent Framework agents on a Foundry project's model, signed in with your Azure login.

The framework runs the tool loop: an Agent on FoundryChatClient (the Responses API) calls the functions it was
given until it has a reply. Its clients are async and belong to the event loop that made them, so this gateway
keeps one loop on its own thread and runs every agent on it; the backend's worker threads wait for the result.
Calls need the Foundry User role on the Foundry resource.
"""
from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from ..core.errors import ApiError

TIMEOUT_S = 180


class FrameworkAgents(Protocol):
    model: str

    def start(self, name: str, instructions: str, tools: list[dict], run_tool: Callable[[str, dict], dict]) -> Any: ...

    def respond(self, agent: Any, text: str) -> tuple[str, dict]: ...


@dataclass
class _Agent:
    agent: Any
    session: Any


class AgentFramework:
    def __init__(self, endpoint: str, model: str, max_iterations: int = 8):
        self.endpoint, self.model, self.max_iterations = endpoint, model, max_iterations
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()

    def _run(self, coro: Any) -> Any:
        with self._lock:
            if self._loop is None:
                self._loop = asyncio.new_event_loop()
                threading.Thread(target=self._loop.run_forever, daemon=True, name="agent-framework").start()
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(TIMEOUT_S)

    def start(self, name: str, instructions: str, tools: list[dict], run_tool: Callable[[str, dict], dict]) -> _Agent:
        """An agent with these tools, in the neutral shape {name, description, parameters}, and a session for it."""
        try:
            from agent_framework import Agent, tool
            from agent_framework.foundry import FoundryChatClient
            from azure.identity import DefaultAzureCredential
        except ImportError as exc:
            raise ApiError(503, "not_installed", "Install Agent Framework: pip install -r examples/medassist/requirements.txt") from exc

        def function(tool_name: str) -> Callable[..., dict]:
            return lambda **args: run_tool(tool_name, args)

        client = FoundryChatClient(project_endpoint=self.endpoint, model=self.model, credential=DefaultAzureCredential(),
                                   function_invocation_configuration={"max_iterations": self.max_iterations})
        agent = Agent(client=client, name=name, instructions=instructions,
                      tools=[tool(function(t["name"]), name=t["name"], description=t["description"], schema=t["parameters"])
                             for t in tools])
        return _Agent(agent, agent.create_session())

    def respond(self, agent: _Agent, text: str) -> tuple[str, dict]:
        """The reply to one input, and its token usage across every round of the tool loop."""
        try:
            response = self._run(agent.agent.run(text, session=agent.session))
        except Exception as exc:  # the framework wraps the SDKs' errors in its own; read them by name and text
            raise _api_error(exc) from exc
        return reply_text(response), dict(response.usage_details or {})


def reply_text(response: Any) -> str:
    """Each distinct piece of text once. response.text runs the pieces together, and models sometimes repeat one."""
    parts: list[str] = []
    for message in response.messages:
        for content in message.contents:
            text = (getattr(content, "text", None) or "").strip() if content.type == "text" else ""
            if text and text not in parts:
                parts.append(text)
    return "\n\n".join(parts)


def _api_error(exc: Exception) -> ApiError:
    words = f"{type(exc).__name__} {exc}".lower()
    if any(w in words for w in ("credential", "authentication", "401", "403", "permission")):
        return ApiError(502, "azure_auth", "Foundry refused the sign-in. Run az login, and check your account has the "
                                           "Foundry User role on the Foundry resource.")
    if "429" in words or "rate" in words:
        return ApiError(429, "rate_limited", "The Foundry model is busy (rate limited). Wait a moment and try again.")
    if isinstance(exc, TimeoutError):
        return ApiError(504, "timeout", "The Foundry model took too long to answer.")
    return ApiError(502, "agent_framework", f"Agent Framework failed: {str(exc)[:300]}")
