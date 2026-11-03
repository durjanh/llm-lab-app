"""Settings for every SDK example: the lab's .env, Azure OpenAI with Entra sign-in (no keys), Claude, and the MCP server."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def _load_dotenv() -> None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

AZURE_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "").rstrip("/")   # https://<resource>.openai.azure.com
AZURE_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENTS", "gpt-5.4-mini").split(",")[0].strip()
AZURE_API_VERSION = "2025-04-01-preview"  # for SDKs that use the classic AzureOpenAI client
AZURE_V1_BASE_URL = f"{AZURE_ENDPOINT}/openai/v1/"  # for SDKs that take an OpenAI base URL
AZURE_SCOPE = "https://cognitiveservices.azure.com/.default"
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")

# The MCP server from examples/mcp, started with the lab's own Python (it needs the MCP SDK 2.x),
# whatever Python the SDK example itself runs on.
MCP_COMMAND = [str(ROOT / ".venv" / "bin" / "python"), str(ROOT / "examples" / "mcp" / "server.py")]


def azure_token_provider():
    """A callable that returns a fresh Entra token for Azure OpenAI (run `az login` first)."""
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider

    return get_bearer_token_provider(DefaultAzureCredential(), AZURE_SCOPE)


def azure_token() -> str:
    """One Entra token, for SDKs that only take a static key or token (valid for about an hour)."""
    return azure_token_provider()()


def check_ready() -> None:
    if not AZURE_ENDPOINT:
        sys.exit("Set AZURE_OPENAI_ENDPOINT in the lab's .env and run `az login`.")
