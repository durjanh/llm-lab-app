"""Shared Semantic Kernel setup for the five tasks: the Azure OpenAI service (Entra sign-in) and the tools as a plugin."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Annotated, Literal

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared import config, engagements  # noqa: E402
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion  # noqa: E402
from semantic_kernel.functions import kernel_function  # noqa: E402

config.check_ready()


def azure_service() -> AzureChatCompletion:
    """gpt-5.4-mini on Azure OpenAI, signed in with your Azure login (keys are off on this resource)."""
    return AzureChatCompletion(deployment_name=config.AZURE_DEPLOYMENT, endpoint=config.AZURE_ENDPOINT,
                               api_version=config.AZURE_API_VERSION, ad_token_provider=config.azure_token_provider())


class EngagementsPlugin:
    """The shared engagement tools as a Semantic Kernel plugin: one @kernel_function per tool."""

    @kernel_function(description="Find engagements by client, name, partner or summary. Returns short summaries.")
    def search_engagements(self, query: Annotated[str, "Words to match; empty matches all"] = "",
                           status: Annotated[Literal["active", "closed", "all"], "active, closed or all"] = "active") -> dict:
        return engagements.search_engagements(query, status)

    @kernel_function(description="The full record of one engagement: partner, budget and spend, % of budget used, risks.")
    def get_engagement(self, engagement_id: Annotated[str, "Such as ENG-104"]) -> dict:
        return engagements.get_engagement(engagement_id)


class WritePlugin:
    """The write tool, kept in its own plugin so only the agent that may write gets it."""

    @kernel_function(description="Record a new risk on an active engagement. This WRITES data and needs a person's approval.")
    def log_risk(self, engagement_id: Annotated[str, "Such as ENG-104"], title: Annotated[str, "One sentence"],
                 severity: Annotated[Literal["low", "medium", "high"], "low, medium or high"],
                 owner: Annotated[str, "Who will manage it"]) -> dict:
        return engagements.log_risk(engagement_id, title, severity, owner)
