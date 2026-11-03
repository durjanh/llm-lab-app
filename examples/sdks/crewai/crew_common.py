"""What every CrewAI script here shares: telemetry off, and the LLM pointed at Azure OpenAI with Entra sign-in."""
from __future__ import annotations

import os
import sys
from pathlib import Path

# CrewAI sends anonymous usage telemetry and offers to collect traces on a first run; switch both off.
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared import config  # noqa: E402

from crewai import LLM  # noqa: E402


def azure_llm() -> LLM:
    """gpt-5.4-mini on Azure OpenAI. With no api_key, CrewAI's native Azure provider signs in with
    DefaultAzureCredential (az login); credential_scopes makes the token one Azure OpenAI accepts."""
    config.check_ready()
    os.environ.pop("AZURE_API_KEY", None)
    return LLM(model=f"azure/{config.AZURE_DEPLOYMENT}", endpoint=config.AZURE_ENDPOINT,
               api_version=config.AZURE_API_VERSION, credential_scopes=[config.AZURE_SCOPE])


def as_tool(func):
    """A shared function as a CrewAI tool. The shared module uses string annotations (PEP 563), which CrewAI's
    schema builder can't resolve, so a thin wrapper carries the real types; the name and docstring stay."""
    import functools
    import typing

    from crewai.tools import tool

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)

    wrapper.__annotations__ = typing.get_type_hints(func)
    del wrapper.__wrapped__  # else signature inspection follows it back to the string annotations
    return tool(func.__name__)(wrapper)
