"""What the pages need to know before they offer live features."""
from __future__ import annotations

from typing import Any

from ..gateways.claude import CredentialChecker
from ..settings import CLAUDE_MODELS, MODELS
from ..shared import CLAUDE_MODEL, DEFAULT_MODEL, HANDBOOK, PRICES, local_status
from .spend import SpendTracker


class StatusService:
    def __init__(self, credentials: CredentialChecker, spend: SpendTracker, gpt_models: list[str] | None = None):
        self.credentials, self.spend = credentials, spend
        self.gpt_models = gpt_models or []  # Azure OpenAI deployments, offered only where a page supports them

    def has_credentials(self) -> bool:
        return self.credentials.has_credentials()

    def report(self) -> dict[str, Any]:
        # claude_models and claude_model are for pages whose work needs Claude; local says whether the local model's
        # server is up, so a page can explain a failure before the person tries.
        return {"ok": True, "has_credentials": self.credentials.has_credentials(), "default_model": DEFAULT_MODEL,
                "models": MODELS, "claude_models": CLAUDE_MODELS, "claude_model": CLAUDE_MODEL, "local": local_status(),
                "gpt_models": self.gpt_models, "prices": PRICES, "spent_usd": round(self.spend.spent_usd, 4),
                "budget_usd": self.spend.budget_usd, "calls": self.spend.calls}

    @staticmethod
    def handbook() -> str:
        return HANDBOOK
