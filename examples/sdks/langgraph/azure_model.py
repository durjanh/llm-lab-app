"""The chat model every LangGraph example uses: Azure OpenAI gpt-5.4-mini, signed in with Entra (no key)."""
from __future__ import annotations

from langchain_openai import AzureChatOpenAI

from shared import config


def llm() -> AzureChatOpenAI:
    config.check_ready()
    return AzureChatOpenAI(azure_endpoint=config.AZURE_ENDPOINT, azure_deployment=config.AZURE_DEPLOYMENT,
                           api_version=config.AZURE_API_VERSION, azure_ad_token_provider=config.azure_token_provider())
