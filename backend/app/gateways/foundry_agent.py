"""A Microsoft Foundry prompt agent (MedAssist), reached through its project, signed in with your Azure login.

The agent itself (its model, instructions and tools) is created by examples/medassist/medassist.py and lives in
the Foundry project. This gateway only holds conversations with it: start one, send input and get the
response, end it. Calls need the Foundry User role on the Foundry resource; the Azure OpenAI roles are not enough.
"""
from __future__ import annotations

import logging
from typing import Any, Protocol

from ..core.errors import ApiError

log = logging.getLogger("llm_lab")


class AgentConversations(Protocol):
    model: str

    def version(self) -> str | None: ...

    def start(self, note: str) -> str: ...

    def respond(self, conversation: str, input: Any) -> Any: ...

    def end(self, conversation: str) -> None: ...


class FoundryAgent:
    def __init__(self, endpoint: str, model: str, agent: str = "MedAssist"):
        self.endpoint, self.model, self.agent = endpoint, model, agent
        self._project: Any = None
        self._openai: Any = None

    def _clients(self) -> tuple[Any, Any]:
        if self._project is None:
            try:
                from azure.ai.projects import AIProjectClient
                from azure.identity import DefaultAzureCredential
            except ImportError as exc:
                raise ApiError(503, "not_installed", "Install azure-ai-projects: pip install -r backend/requirements.txt") from exc
            self._project = AIProjectClient(endpoint=self.endpoint, credential=DefaultAzureCredential())
            self._openai = self._project.get_openai_client()
        return self._project, self._openai

    def _call(self, what: str, fn):
        """Runs one Foundry call and turns its failures into messages the page can show."""
        import openai
        from azure.core.exceptions import ClientAuthenticationError, HttpResponseError, ResourceNotFoundError

        try:
            return fn()
        except (ResourceNotFoundError, openai.NotFoundError) as exc:
            raise ApiError(409, "agent_missing", f"There is no {self.agent} agent in the Foundry project yet. Run "
                                                 "python examples/medassist/medassist.py create, then try again.") from exc
        except (ClientAuthenticationError, openai.AuthenticationError, openai.PermissionDeniedError) as exc:
            raise ApiError(502, "azure_auth", "Foundry refused the sign-in. Run az login, and check your account has "
                                              "the Foundry User role on the Foundry resource.") from exc
        except openai.RateLimitError as exc:
            raise ApiError(429, "rate_limited", "The Foundry model is busy (rate limited). Wait a moment and try again.") from exc
        except (HttpResponseError, openai.APIError) as exc:
            log.warning("Foundry %s failed: %s", what, exc)
            raise ApiError(502, "foundry_error", f"Foundry {what} failed: {exc}") from exc

    def version(self) -> str | None:
        """The agent's latest version, or None when it has not been created."""
        project, _ = self._clients()
        try:
            return self._call("agent lookup", lambda: str(project.agents.get(agent_name=self.agent).versions.latest.version))
        except ApiError as exc:
            if exc.kind == "agent_missing":
                return None
            raise

    def start(self, note: str) -> str:
        _, client = self._clients()
        return self._call("conversation", lambda: client.conversations.create(
            items=[{"type": "message", "role": "developer", "content": note}]).id)

    def respond(self, conversation: str, input: Any) -> Any:
        _, client = self._clients()
        agent = {"agent_reference": {"name": self.agent, "type": "agent_reference"}}
        return self._call("response", lambda: client.responses.create(conversation=conversation, input=input,
                                                                      extra_body=agent))

    def end(self, conversation: str) -> None:
        _, client = self._clients()
        try:
            client.conversations.delete(conversation)
        except Exception as exc:  # already gone, or the network dropped: nothing to tidy up
            log.info("Could not delete Foundry conversation %s: %s", conversation, exc)
