"""What every Google ADK example shares: Azure OpenAI through ADK's LiteLLM wrapper (Entra sign-in, no key), and a runner."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from google.adk.models.lite_llm import LiteLlm  # noqa: E402
from google.adk.runners import InMemoryRunner  # noqa: E402
from google.genai import types  # noqa: E402

from shared import config  # noqa: E402

os.environ.setdefault("LITELLM_LOG", "ERROR")


def model() -> LiteLlm:
    """gpt-5.4-mini on Azure OpenAI. LiteLLM's `azure/<deployment>` route takes azure_ad_token_provider, which
    signs in with DefaultAzureCredential (az login)."""
    config.check_ready()
    return LiteLlm(model=f"azure/{config.AZURE_DEPLOYMENT}", api_base=config.AZURE_ENDPOINT,
                   api_version=config.AZURE_API_VERSION, azure_ad_token_provider=config.azure_token_provider())


def message(text: str) -> types.Content:
    return types.Content(role="user", parts=[types.Part(text=text)])


async def ask(agent, prompt: str | types.Content, session_id: str = "s", runner: InMemoryRunner | None = None):
    """Run the agent on one message in a fresh in-memory session; yield its events."""
    runner = runner or InMemoryRunner(agent=agent, app_name="sdks")
    if not await runner.session_service.get_session(app_name="sdks", user_id="u", session_id=session_id):
        await runner.session_service.create_session(app_name="sdks", user_id="u", session_id=session_id)
    content = message(prompt) if isinstance(prompt, str) else prompt
    async for event in runner.run_async(user_id="u", session_id=session_id, new_message=content):
        yield event


def final_text(event) -> str | None:
    """The agent's closing answer, if this event is one."""
    if event.is_final_response() and event.content and event.content.parts:
        return "".join(p.text or "" for p in event.content.parts)
    return None
