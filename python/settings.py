"""Every environment variable the lab reads, in one place: the lesson scripts and the backend both use this.

Importing it loads the project's .env file. Code elsewhere asks EnvSettings for a value instead of
reading os.environ, so this file is the full list of what can be configured.
"""
from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_dotenv() -> None:
    """Read KEY=VALUE lines from a .env file in the project root or this folder.

    Variables already set in the environment win, so a key exported in your
    shell overrides the file. The file is listed in .gitignore; never commit it.
    """
    for path in (HERE.parent / ".env", HERE / ".env"):
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class EnvSettings:
    """What the environment and .env say. ANTHROPIC_API_KEY is not here: the SDK reads it itself."""
    model: str = "claude-haiku-5-5"  # LLM_LAB_MODEL: the scripts' and the backend's default Claude model
    # LLM_LAB_LOCAL_MODEL: an open model on this machine (Docker Model Runner, or Ollama). When set, it is the default
    # wherever the work needs nothing only Claude has; LLM_LAB_MODEL stays the default for the rest.
    local_model: str = ""
    # LLM_LAB_LOCAL_URL: the local server's Anthropic-compatible API, and LLM_LAB_LOCAL_OPENAI_URL its OpenAI-compatible
    # one (used for replies that must match a JSON schema). The defaults are Docker Model Runner's on port 12434.
    local_url: str = "http://localhost:12434/anthropic"
    local_openai_url: str = "http://localhost:12434/engines/v1"
    # The backend. `python -m backend` sets the first two from its --port and --budget flags.
    port: int = 8000  # LLM_LAB_PORT
    budget_usd: float = 2.0  # LLM_LAB_BUDGET
    dev_port: int = 5173  # LLM_LAB_DEV_PORT: the Vite dev server, allowed to call the API
    chrome_path: str = ""  # LLM_LAB_CHROME: Chrome for the site builder's screenshots, if not in a usual place
    # LLM_LAB_SANDBOX: how the coding agent's auto mode contains its commands. auto picks sandbox-exec on macOS and
    # bubblewrap on Linux; sessions sends commands to Azure Container Apps dynamic sessions; container says each
    # session already runs in its own disposable container; none turns it off.
    coding_sandbox: str = "auto"
    coding_sessions_endpoint: str = ""  # LLM_LAB_SESSIONS_ENDPOINT: the sandbox, for LLM_LAB_SANDBOX=sessions
    # LLM_LAB_SESSIONS_SCOPE: the token scope for it. Empty for a session pool (https://dynamicsessions.io); the
    # sandbox container app's api://<app id>/.default for the Consumption option.
    coding_sessions_scope: str = ""
    # The tutor's voice: a key and region, or a resource ID signed in with your Azure login.
    azure_speech_key: str = field(default="", repr=False)
    azure_speech_region: str = ""
    azure_speech_resource_id: str = ""
    azure_speech_fallback_resource_id: str = ""
    # GPT models and embeddings in Azure AI Foundry, and Azure AI Search. Signed in with your Azure login.
    azure_openai_endpoint: str = ""
    azure_openai_deployments: tuple[str, ...] = ()
    azure_openai_embedding_deployment: str = ""
    azure_search_endpoint: str = ""
    # A Microsoft Foundry project and its model, for prompt agents such as MedAssist. Signed in with your Azure login.
    foundry_project_endpoint: str = ""
    foundry_model: str = ""
    # Azure Language in Foundry Tools (an AI Services or Language resource), for the review dashboard.
    azure_language_endpoint: str = ""
    azure_media_endpoint: str = ""  # a second AI Services resource where gpt-image-2 and groundedness detection run
    azure_ai_resource_id: str = ""  # ARM ids, for reading deployments, quotas, metrics and security settings
    azure_media_resource_id: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "EnvSettings":
        get = env.get
        return cls(
            model=get("LLM_LAB_MODEL") or cls.model,
            local_model=get("LLM_LAB_LOCAL_MODEL", "").strip(),
            local_url=(get("LLM_LAB_LOCAL_URL") or cls.local_url).rstrip("/"),
            local_openai_url=(get("LLM_LAB_LOCAL_OPENAI_URL") or cls.local_openai_url).rstrip("/"),
            port=int(get("LLM_LAB_PORT") or cls.port),
            budget_usd=float(get("LLM_LAB_BUDGET") or cls.budget_usd),
            dev_port=int(get("LLM_LAB_DEV_PORT") or cls.dev_port),
            chrome_path=get("LLM_LAB_CHROME", ""),
            coding_sandbox=(get("LLM_LAB_SANDBOX") or cls.coding_sandbox).strip().lower(),
            coding_sessions_endpoint=get("LLM_LAB_SESSIONS_ENDPOINT", "").rstrip("/"),
            coding_sessions_scope=get("LLM_LAB_SESSIONS_SCOPE", ""),
            azure_speech_key=get("AZURE_SPEECH_KEY", ""),
            azure_speech_region=get("AZURE_SPEECH_REGION", ""),
            azure_speech_resource_id=get("AZURE_SPEECH_RESOURCE_ID", ""),
            azure_speech_fallback_resource_id=get("AZURE_SPEECH_FALLBACK_RESOURCE_ID", ""),
            azure_openai_endpoint=get("AZURE_OPENAI_ENDPOINT", ""),
            azure_openai_deployments=tuple(d.strip() for d in get("AZURE_OPENAI_DEPLOYMENTS", "").split(",") if d.strip()),
            azure_openai_embedding_deployment=get("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", ""),
            azure_search_endpoint=get("AZURE_SEARCH_ENDPOINT", ""),
            foundry_project_endpoint=get("FOUNDRY_PROJECT_ENDPOINT", ""),
            foundry_model=get("FOUNDRY_MODEL", ""),
            azure_language_endpoint=get("AZURE_LANGUAGE_ENDPOINT", ""),
            azure_media_endpoint=get("AZURE_MEDIA_ENDPOINT", ""),
            azure_ai_resource_id=get("AZURE_AI_RESOURCE_ID", ""),
            azure_media_resource_id=get("AZURE_MEDIA_RESOURCE_ID", ""),
        )


load_dotenv()
ENV = EnvSettings.from_env()
