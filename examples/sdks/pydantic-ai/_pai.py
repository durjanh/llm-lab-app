"""What every PydanticAI example shares: the Anthropic model, Claude Haiku."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")  # the startup banner is noise in the results
from pydantic_ai.models.anthropic import AnthropicModel  # noqa: E402

from shared import config  # noqa: E402,F401  (loads the lab's .env, so ANTHROPIC_API_KEY is set)

MODEL = "claude-haiku-5-5"


def model() -> AnthropicModel:
    """PydanticAI's Anthropic model; its default provider reads ANTHROPIC_API_KEY from the environment."""
    return AnthropicModel(MODEL)
