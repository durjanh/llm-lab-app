"""What every Agent Framework example shares: the Azure OpenAI chat client (Entra sign-in) and tracing.

AF_API=responses runs any task on the Responses API instead of Chat Completions; the agent code does not change.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_framework import FunctionInvocationContext, function_middleware  # noqa: E402
from agent_framework.openai import OpenAIChatClient, OpenAIChatCompletionClient  # noqa: E402
from azure.identity import DefaultAzureCredential  # noqa: E402

from shared import config  # noqa: E402

config.check_ready()

API = os.environ.get("AF_API", "chat")  # "chat" (Chat Completions) or "responses"


def chat_client(max_iterations: int = 10, api: str = API) -> OpenAIChatCompletionClient | OpenAIChatClient:
    """Azure OpenAI, signed in with your Azure login. max_iterations caps the tool loop.

    Mind the names: OpenAIChatClient is the Responses client; OpenAIChatCompletionClient is Chat Completions.
    """
    cls = {"chat": OpenAIChatCompletionClient, "responses": OpenAIChatClient}[api]
    return cls(
        model=config.AZURE_DEPLOYMENT, azure_endpoint=config.AZURE_ENDPOINT, credential=DefaultAzureCredential(),
        function_invocation_configuration={"max_iterations": max_iterations},
    )


@function_middleware
async def trace(context: FunctionInvocationContext, call_next) -> None:
    """Middleware around every tool call: one trace line in, one out."""
    args = context.arguments if isinstance(context.arguments, dict) else getattr(context.arguments, "model_dump", dict)()
    print(f"  -> {context.function.name}({json.dumps(args, default=str)})")
    await call_next()
