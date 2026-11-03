"""Shared AutoGen setup for the five tasks: the Azure OpenAI model client with Entra sign-in."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared import config  # noqa: E402
from autogen_ext.models.openai import AzureOpenAIChatCompletionClient  # noqa: E402

config.check_ready()


def azure_client() -> AzureOpenAIChatCompletionClient:
    """gpt-5.4-mini on Azure OpenAI, signed in with your Azure login. AutoGen only knows OpenAI's own model names,
    so a newer deployment needs model_info describing what it can do."""
    return AzureOpenAIChatCompletionClient(
        azure_deployment=config.AZURE_DEPLOYMENT, model=config.AZURE_DEPLOYMENT, azure_endpoint=config.AZURE_ENDPOINT,
        api_version=config.AZURE_API_VERSION, azure_ad_token_provider=config.azure_token_provider(),
        model_info={"vision": True, "function_calling": True, "json_output": True, "structured_output": True,
                    "family": "unknown", "multiple_system_messages": True})
