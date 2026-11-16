"""What every CAMEL example shares: the Azure OpenAI model, signed in with Entra (no key)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from camel.models import ModelFactory  # noqa: E402
from camel.toolkits import FunctionTool  # noqa: E402
from camel.types import ModelPlatformType  # noqa: E402

from shared import config  # noqa: E402


def model():
    """gpt-5.4-mini on Azure OpenAI; azure_ad_token_provider signs in with DefaultAzureCredential (az login)."""
    config.check_ready()
    os.environ.pop("AZURE_OPENAI_API_KEY", None)
    return ModelFactory.create(model_platform=ModelPlatformType.AZURE, model_type=config.AZURE_DEPLOYMENT,
                               url=config.AZURE_ENDPOINT, api_version=config.AZURE_API_VERSION,
                               azure_ad_token_provider=config.azure_token_provider())


def as_tools(functions) -> list:
    """The shared Python functions as CAMEL tools: the schema comes from the signature and docstring."""
    return [FunctionTool(f) for f in functions]
