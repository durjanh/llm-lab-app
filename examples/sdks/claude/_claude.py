"""What every Claude example shares: the client, the model, and the server-side refusal fallback."""
from __future__ import annotations

import functools
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from anthropic import Anthropic, AsyncAnthropic, beta_tool  # noqa: E402

from shared import config  # noqa: E402  (loads the lab's .env, so ANTHROPIC_API_KEY is set)

MODEL = config.CLAUDE_MODEL
# Opus 5.5 can decline a request (stop_reason "refusal"); this asks the server to retry on a fallback model.
FALLBACKS = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
EFFORT = {"effort": "low"}  # these tasks are simple; low effort keeps them fast and cheap


def client() -> Anthropic:
    return Anthropic()


def async_client() -> AsyncAnthropic:
    return AsyncAnthropic()


def as_tool(fn, before=None):
    """A shared Python function as a Claude tool: the schema comes from its signature and docstring.
    Results are returned as JSON text. `before(name, args)` can veto the call (the approval gate)."""
    @functools.wraps(fn)
    def run(**kwargs):
        print(f"  -> {fn.__name__}({json.dumps(kwargs)})")
        if before and not before(fn.__name__, kwargs):
            return "A person declined this call. Do not retry it; say it was not done."
        return json.dumps(fn(**kwargs))
    return beta_tool(run)


def text_of(message) -> str:
    return "".join(b.text for b in message.content if b.type == "text").strip()


def refused(message) -> bool:
    if message.stop_reason == "refusal":
        print("Claude declined this request.")
        return True
    return False
