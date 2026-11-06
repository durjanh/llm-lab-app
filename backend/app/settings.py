"""Server settings. Values that come from the environment are read by python/settings.py (EnvSettings), not here."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .shared import LOCAL_MODEL, ROOT, EnvSettings

CLAUDE_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]
# The local open model, when one is configured (LLM_LAB_LOCAL_MODEL), comes first: it is the default where it can do
# the work. Pages that need something only Claude has offer CLAUDE_MODELS.
MODELS = ([LOCAL_MODEL] if LOCAL_MODEL else []) + CLAUDE_MODELS
MAX_TOKENS_STREAMING = 32000
MAX_TOKENS_NON_STREAMING = 16000  # the SDK requires streaming for larger values
VITE_DEV_PORT = 5173


@dataclass(frozen=True)
class Settings:
    port: int = 8000
    budget_usd: float = 2.0
    frontend_dist: Path = ROOT / "frontend" / "dist"
    models_dir: Path = ROOT / "models"
    generated_dir: Path = ROOT / "generated"  # media the AI-103 labs make (photos, video); ignored by git
    # Pages may call the API from the backend itself or from the Vite dev server.
    extra_ports: tuple[int, ...] = field(default=(VITE_DEV_PORT,))
    run_budget_usd: float = 0.25  # the most one live agent run may spend, inside budget_usd
    approval_timeout_s: float = 120.0  # a bash command nobody answers is refused
    heartbeat_s: float = 10.0  # live streams send an empty line this often, so a closed page is noticed
    sites_dir: Path = ROOT / "sites"  # the site builder's sites: their files, conversations and screenshots
    chrome_path: str = ""  # Chrome for the site builder's screenshots; empty means look in the usual places
    # The English tutor's voice. Empty means the tutor works in text only.
    azure_speech_key: str = field(default="", repr=False)
    azure_speech_region: str = ""
    # Or, with no key, sign in with your Azure login to this AI Services or Speech resource.
    azure_speech_resource_id: str = ""
    # Used when the first resource refuses, for example once a free tier's monthly allowance is used up.
    azure_speech_fallback_resource_id: str = ""
    # GPT models in Azure AI Foundry, offered beside Claude in the document automation lab. Signed in
    # with your Azure login; empty means Claude only.
    azure_openai_endpoint: str = ""
    azure_openai_deployments: tuple[str, ...] = ()
    azure_openai_embedding_deployment: str = ""
    # Azure AI Search, for the case-handling lab's policy retrieval. Signed in with your Azure login.
    azure_search_endpoint: str = ""
    casework_dir: Path = ROOT / "casework"  # the case-handling lab's audit log
    # MedAssist: the Foundry prompt agent from examples/medassist, and the dummy practice database it books into
    # (shared with that example's command line). Signed in with your Azure login; empty means the page is offline.
    foundry_project_endpoint: str = ""
    foundry_model: str = ""
    medassist_db: Path = ROOT / "examples" / "medassist" / "data" / "medassist.db"
    aftercare_db: Path = ROOT / "examples" / "aftercare" / "data" / "aftercare.db"
    # Azure Language in Foundry Tools, for the review dashboard. Signed in with your Azure login; empty means offline.
    azure_language_endpoint: str = ""
    azure_media_endpoint: str = ""
    azure_ai_resource_id: str = ""
    azure_media_resource_id: str = ""

    @classmethod
    def from_env(cls, env: EnvSettings | None = None) -> "Settings":
        """Settings from the environment and .env. Read afresh, so values `python -m backend` set from its flags count."""
        env = env or EnvSettings.from_env()
        return cls(
            port=env.port,
            budget_usd=env.budget_usd,
            extra_ports=(env.dev_port,),
            chrome_path=env.chrome_path,
            azure_speech_key=env.azure_speech_key,
            azure_speech_region=env.azure_speech_region,
            azure_speech_resource_id=env.azure_speech_resource_id,
            azure_speech_fallback_resource_id=env.azure_speech_fallback_resource_id,
            azure_openai_endpoint=env.azure_openai_endpoint,
            azure_openai_deployments=env.azure_openai_deployments,
            azure_openai_embedding_deployment=env.azure_openai_embedding_deployment,
            azure_search_endpoint=env.azure_search_endpoint,
            foundry_project_endpoint=env.foundry_project_endpoint,
            foundry_model=env.foundry_model,
            azure_language_endpoint=env.azure_language_endpoint,
            azure_media_endpoint=env.azure_media_endpoint,
            azure_ai_resource_id=env.azure_ai_resource_id,
            azure_media_resource_id=env.azure_media_resource_id,
        )

    @property
    def origin(self) -> str:
        """This server's own address, for the headless browser that screenshots the sites."""
        return f"http://127.0.0.1:{self.port}"

    @property
    def allowed_hosts(self) -> set[str]:
        ports = (self.port, *self.extra_ports)
        return {f"{host}:{port}" for host in ("localhost", "127.0.0.1") for port in ports}
