"""What every OpenAI Agents SDK script here shares: an Azure-backed model, the shared tools as function
tools, and a hook that prints each tool call.

The Agents SDK talks to OpenAI by default and sends traces to OpenAI's platform. Here it gets an
AsyncOpenAI client pointed at Azure (Entra token, no key) wrapped in OpenAIChatCompletionsModel, and its
OpenAI trace exporter is switched off, since there is no OpenAI key to send traces with.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agents import OpenAIChatCompletionsModel, RunHooks, function_tool, set_tracing_disabled  # noqa: E402
from openai import AsyncOpenAI  # noqa: E402

from shared import config, engagements  # noqa: E402

set_tracing_disabled(True)


def model() -> OpenAIChatCompletionsModel:
    config.check_ready()
    token = config.azure_token_provider()

    async def api_key() -> str:  # the async client wants an async callable
        return token()

    return OpenAIChatCompletionsModel(model=config.AZURE_DEPLOYMENT,
                                      openai_client=AsyncOpenAI(base_url=config.AZURE_V1_BASE_URL, api_key=api_key))


# The shared functions become tools: the SDK reads the signature and the Google-style docstring.
search_engagements = function_tool(engagements.search_engagements)
get_engagement = function_tool(engagements.get_engagement)
log_risk = function_tool(engagements.log_risk, needs_approval=True)  # the run pauses for a person before this runs


class Trace(RunHooks):
    """Prints every tool call as it starts."""

    async def on_tool_start(self, context: Any, agent: Any, tool: Any) -> None:
        print(f"  [{agent.name}] tool: {getattr(context, 'tool_name', tool.name)}({getattr(context, 'tool_arguments', '')})")
