"""What every LlamaIndex example shares: the Azure OpenAI LLM, signed in with Entra (no key)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llama_index.llms.azure_openai import AzureOpenAI  # noqa: E402

from shared import config  # noqa: E402


class EntraAzureOpenAI(AzureOpenAI):
    """LlamaIndex's Azure LLM sends the token as api_key and as azure_ad_token_provider; openai 3.x refuses both
    at once. Dropping api_key leaves the provider, which the client calls before each request."""

    def _get_credential_kwargs(self, is_async: bool = False, **kwargs):
        creds = super()._get_credential_kwargs(is_async, **kwargs)
        creds.pop("api_key", None)
        return creds


def llm() -> AzureOpenAI:
    """gpt-5.4-mini on Azure OpenAI; the token provider signs in with DefaultAzureCredential (az login)."""
    config.check_ready()
    return EntraAzureOpenAI(engine=config.AZURE_DEPLOYMENT, model=config.AZURE_DEPLOYMENT, azure_endpoint=config.AZURE_ENDPOINT,
                            api_version=config.AZURE_API_VERSION, azure_ad_token_provider=config.azure_token_provider(),
                            use_azure_ad=True)
