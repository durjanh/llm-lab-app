"""Settings for every AI stack example: the lab's .env, Claude, Azure OpenAI with Entra sign-in, and each area's ports.

Standard library only, so any tool's virtual environment can import it. Keys are read from the environment at run
time and never printed.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # the repository root
STACK = ROOT / "examples" / "stack"


def _load_dotenv() -> None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

# Generation and judging: the cheapest Claude model unless STACK_CLAUDE_MODEL says otherwise.
CLAUDE_MODEL = os.environ.get("STACK_CLAUDE_MODEL", "claude-haiku-5-5")
HAS_CLAUDE = bool(os.environ.get("ANTHROPIC_API_KEY"))

# Azure OpenAI, keyless (az login). Embeddings use text-embedding-3-large where a tool needs a hosted embedder.
AZURE_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
AZURE_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENTS", "gpt-5.4-mini").split(",")[0].strip()
AZURE_EMBEDDING = os.environ.get("AZURE_OPENAI_EMBEDDING", "text-embedding-3-large")
AZURE_API_VERSION = "2025-04-01-preview"
AZURE_V1_BASE_URL = f"{AZURE_ENDPOINT}/openai/v1/" if AZURE_ENDPOINT else ""
AZURE_SCOPE = "https://cognitiveservices.azure.com/.default"

# Local embeddings with no key: a small BGE model through sentence-transformers or fastembed.
LOCAL_EMBEDDING = "BAAI/bge-small-en-v1.5"

# The lab's own PostgreSQL with pgvector (docker, started by the lab), used as a baseline.
PGVECTOR_URL = os.environ.get("LLM_LAB_PGVECTOR_URL", "postgresql://lab:lab@127.0.0.1:5433/vectors")

# Host ports each area may use for containers, all bound to 127.0.0.1, so areas never collide.
PORTS = {
    "rag": range(18100, 18200),
    "models": range(18200, 18300),
    "mcp-servers": range(18300, 18400),
    "security": range(18400, 18500),
    "observability": range(18500, 18600),
    "memory": range(18600, 18700),
    "vector-dbs": range(18700, 18800),
    "automation": range(18800, 18900),
}


def env(name: str) -> str:
    """A setting from the environment or the lab's .env, or empty."""
    return os.environ.get(name, "").strip()
