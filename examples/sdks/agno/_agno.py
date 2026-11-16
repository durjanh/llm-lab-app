"""What every Agno example shares: the Azure OpenAI model, signed in with Entra (no key)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agno.models.azure import AzureOpenAI  # noqa: E402

from shared import config  # noqa: E402


def model() -> AzureOpenAI:
    """gpt-5.4-mini on Azure OpenAI; azure_ad_token_provider signs in with DefaultAzureCredential (az login)."""
    config.check_ready()
    return AzureOpenAI(id=config.AZURE_DEPLOYMENT, azure_endpoint=config.AZURE_ENDPOINT,
                       azure_deployment=config.AZURE_DEPLOYMENT, api_version=config.AZURE_API_VERSION,
                       azure_ad_token_provider=config.azure_token_provider())
