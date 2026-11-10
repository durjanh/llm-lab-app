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
    # LLM_LAB_LOCAL_CONTEXT: the context the local model runs with (tools/local-model.sh sets it on the server). Long
    # agent runs keep their conversation inside it by shortening older steps (sandbox_skills.fit_context).
    local_context: int = 32768
    # LLM_LAB_RATE_LIMIT_FALLBACK: the model that answers when a model is rate limited or overloaded (429 or 529)
    # after the SDK's own retries. auto: a GPT deployment for Claude (or the local model when there is no GPT), and
    # Claude for GPT. none: no fallback. Or a model id.
    rate_limit_fallback: str = "auto"
    # The backend. `python -m backend` sets the first two from its --port and --budget flags.
    port: int = 8000  # LLM_LAB_PORT
    budget_usd: float = 2.0  # LLM_LAB_BUDGET
    dev_port: int = 5173  # LLM_LAB_DEV_PORT: the Vite dev server, allowed to call the API
    chrome_path: str = ""  # LLM_LAB_CHROME: Chrome for the site builder's screenshots, if not in a usual place
    # LLM_LAB_SANDBOX: how the coding agent's auto mode contains its commands. auto picks sandbox-exec on macOS and
    # bubblewrap on Linux; docker sends commands to the sandbox image running in Docker on this machine
    # (tools/sandbox.sh); sessions sends them to the sandbox in Azure Container Apps; container says each session
    # already runs in its own disposable container; none turns it off.
    coding_sandbox: str = "auto"
    docker_sandbox_url: str = "http://127.0.0.1:8099"  # LLM_LAB_DOCKER_SANDBOX_URL: the local container, for docker
    coding_sessions_endpoint: str = ""  # LLM_LAB_SESSIONS_ENDPOINT: the sandbox, for LLM_LAB_SANDBOX=sessions
    # LLM_LAB_SESSIONS_SCOPE: the token scope for it. Empty for a session pool (https://dynamicsessions.io); the
    # sandbox container app's api://<app id>/.default for the Consumption option.
    coding_sessions_scope: str = ""
    # The tutor's voice: a key and region, or a resource ID signed in with your Azure login.
    azure_speech_key: str = field(default="", repr=False)
    azure_speech_region: str = ""
    azure_speech_resource_id: str = ""
    azure_speech_fallback_resource_id: str = ""
    # GPT models and embeddings in Microsoft Foundry, and Azure AI Search. Signed in with your Azure login.
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
    # MedAssist's real texts (examples/medassist/sms.py). MEDASSIST_SMS_ENDPOINT and MEDASSIST_REMINDERS_TABLE are
    # written by azd; MEDASSIST_SMS_TO is yours: the one phone real texts go to, because the patients are invented.
    # Without all three, texts stay rows in the practice database, as before.
    medassist_sms_endpoint: str = ""
    medassist_sms_sender: str = "Durjan Lab"  # a registered alphanumeric sender ID: letters, digits, spaces, 11 at most
    medassist_sms_to: str = ""
    medassist_reminders_table: str = ""
    # The hotel booking agent's confirmations (examples/hotel/). They are always kept in its outbox; they are sent for
    # real only when you say where to, because the guests are invented: HOTEL_SMS_TO is your phone (texts go through
    # the MEDASSIST_SMS_ENDPOINT resource), HOTEL_EMAIL_TO your inbox, and HOTEL_EMAIL_SENDER an address on an email
    # domain connected to that resource (pip install azure-communication-email).
    hotel_sms_to: str = ""
    hotel_email_to: str = ""
    hotel_email_sender: str = ""
    # Aftercare's real phone call (backend/app/services/aftercare_phone.py), through the same Communication Services
    # resource: AFTERCARE_CALLER_ID is a number you bought in it, AFTERCARE_CALL_TO your own phone, and
    # AFTERCARE_CALLBACK_URL the public address of your backend (a dev tunnel) where the call's events arrive.
    aftercare_caller_id: str = ""
    aftercare_call_to: str = ""
    aftercare_callback_url: str = ""
    aftercare_speech_endpoint: str = ""  # AFTERCARE_SPEECH_ENDPOINT, else AZURE_LANGUAGE_ENDPOINT: the AI Services
    # The practice's phone line (backend/app/services/medassist_phone.py): your phone is answered as this invented
    # patient, and Event Grid's incoming calls must carry MEDASSIST_PHONE_TOKEN (setup-phone-line.sh makes one).
    medassist_phone_patient: str = "P002"
    medassist_phone_token: str = ""
    # MEDASSIST_PHONE_LANGUAGE: the language your phone is answered in, and the test patient's texts are written in
    # (python/translator.py's codes: pl, ur, pa, ar...). Empty: the patient's preference in the record.
    medassist_phone_language: str = ""
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
            rate_limit_fallback=(get("LLM_LAB_RATE_LIMIT_FALLBACK") or cls.rate_limit_fallback).strip(),
            local_context=int(get("LLM_LAB_LOCAL_CONTEXT") or cls.local_context),
            port=int(get("LLM_LAB_PORT") or cls.port),
            budget_usd=float(get("LLM_LAB_BUDGET") or cls.budget_usd),
            dev_port=int(get("LLM_LAB_DEV_PORT") or cls.dev_port),
            chrome_path=get("LLM_LAB_CHROME", ""),
            coding_sandbox=(get("LLM_LAB_SANDBOX") or cls.coding_sandbox).strip().lower(),
            coding_sessions_endpoint=get("LLM_LAB_SESSIONS_ENDPOINT", "").rstrip("/"),
            docker_sandbox_url=(get("LLM_LAB_DOCKER_SANDBOX_URL") or cls.docker_sandbox_url).rstrip("/"),
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
            medassist_sms_endpoint=get("MEDASSIST_SMS_ENDPOINT", "").rstrip("/"),
            medassist_sms_sender=get("MEDASSIST_SMS_SENDER") or cls.medassist_sms_sender,
            medassist_sms_to=get("MEDASSIST_SMS_TO", "").strip(),
            medassist_reminders_table=get("MEDASSIST_REMINDERS_TABLE", "").rstrip("/"),
            hotel_sms_to=get("HOTEL_SMS_TO", "").strip(),
            hotel_email_to=get("HOTEL_EMAIL_TO", "").strip(),
            hotel_email_sender=get("HOTEL_EMAIL_SENDER", "").strip(),
            aftercare_caller_id=get("AFTERCARE_CALLER_ID", "").strip(),
            medassist_phone_patient=get("MEDASSIST_PHONE_PATIENT") or cls.medassist_phone_patient,
            medassist_phone_token=get("MEDASSIST_PHONE_TOKEN", "").strip(),
            medassist_phone_language=get("MEDASSIST_PHONE_LANGUAGE", "").strip(),
            aftercare_call_to=get("AFTERCARE_CALL_TO", "").strip(),
            aftercare_callback_url=get("AFTERCARE_CALLBACK_URL", "").rstrip("/"),
            aftercare_speech_endpoint=(get("AFTERCARE_SPEECH_ENDPOINT") or get("AZURE_LANGUAGE_ENDPOINT", "")).rstrip("/"),
            azure_ai_resource_id=get("AZURE_AI_RESOURCE_ID", ""),
            azure_media_resource_id=get("AZURE_MEDIA_RESOURCE_ID", ""),
        )


load_dotenv()
ENV = EnvSettings.from_env()
