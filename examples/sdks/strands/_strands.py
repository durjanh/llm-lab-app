"""What every Strands example shares: the Anthropic model provider, pointed at Claude Haiku."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from strands import tool  # noqa: E402
from strands.models.anthropic import AnthropicModel  # noqa: E402

from shared import config  # noqa: E402,F401  (loads the lab's .env, so ANTHROPIC_API_KEY is set)

MODEL = "claude-haiku-5-5"


def model() -> AnthropicModel:
    """Strands' Anthropic provider; it reads ANTHROPIC_API_KEY from the environment."""
    return AnthropicModel(model_id=MODEL, max_tokens=4096)


def as_tools(functions) -> list:
    """The shared Python functions as Strands tools: the schema comes from the signature and docstring."""
    return [tool(f) for f in functions]
