"""Shared helpers for the LLM Lab scripts.

Generation requests go through the SDK's beta endpoint so they can opt into
Anthropic's server-side refusal fallbacks: if the requested model declines a
request on safety grounds, the API re-runs it on a recommended fallback model
instead of returning the refusal. Claude Haiku 5.5 has no server-side fallback,
so its requests use the standard endpoint.

With LLM_LAB_LOCAL_MODEL set, an open model on this machine is the default model, and make_client() returns a client
that sends its requests to the local server (local_model.py). With AZURE_OPENAI_ENDPOINT set, the same client sends
requests for a GPT deployment (GPT_MODELS) to Azure OpenAI (gpt_model.py). Work only Claude can do uses CLAUDE_MODEL.
"""
from __future__ import annotations

import argparse
import math
import sys
from typing import Any, Callable

import anthropic

from local_model import GPT_MODELS, LOCAL_MODEL, LOCAL_PRICE, LabClient, ModelUnavailable, NeedsClaude, is_local
from settings import ENV  # loads .env

CLAUDE_MODEL = ENV.model  # the default for work that needs Claude (server tools, files, skills, code execution)
DEFAULT_MODEL = LOCAL_MODEL or CLAUDE_MODEL  # the default everywhere else

# Models that accept fallbacks="default" on the Claude API.
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5"}
FALLBACKS = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}

# Anthropic list prices in US dollars per million tokens, October 2026.
# Check Anthropic's pricing page before relying on them. The Haiku cache-read
# price is an assumption at the usual 0.1x of the input price.
PRICES: dict[str, dict[str, float]] = {
    "claude-opus-5-5": {"input": 4.00, "output": 20.00, "cache_read": 0.20},
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_read": 0.20},
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_read": 0.01},
}
# Azure OpenAI Global Standard list prices per million tokens, from the Azure retail price list (UK South).
# Here so the backend's spend tracker and the scripts charge GPT calls from the same table as Claude's.
GPT_PRICES: dict[str, dict[str, float]] = {
    "gpt-5.4-mini": {"input": 0.75, "output": 4.50, "cache_read": 0.075},
    "text-embedding-3-small": {"input": 0.02, "output": 0.0, "cache_read": 0.0},
    "gpt-4.1-mini": {"input": 0.40, "output": 1.60, "cache_read": 0.10},
    "text-embedding-3-large": {"input": 0.13, "output": 0.0, "cache_read": 0.0},
    # gpt-image-2 is not in the retail list yet: gpt-image-1's Global Standard rates (Sweden Central) stand in.
    # Text input, image output; image input (reference images, masks) is $10 per million tokens.
    "gpt-image-2": {"input": 5.00, "output": 40.00, "cache_read": 1.25},
}
IMAGE_INPUT_PRICE_PER_M = 10.00
PRICES.update(GPT_PRICES)
if LOCAL_MODEL:
    PRICES[LOCAL_MODEL] = LOCAL_PRICE  # runs on this machine: no charge per token
CACHE_WRITE_MULTIPLIER = 1.25  # 5-minute cache entries
# Azure Language in Foundry Tools, Standard tier, first 500,000 text records a month, from the Azure retail price list
# (UK South). Each feature bills one text record per started 1,000 characters of each document.
LANGUAGE_PRICE_PER_1K_RECORDS = 1.00
# Other Foundry Tools the AI-103 labs call, Standard tier, from the same price list (UK South).
TOOL_PRICES = {
    "content_safety_text_per_1k": 0.375,  # one text record per started 1,000 characters
    "content_safety_image_per_1k": 0.75,
    "translator_per_1m_chars": 10.00,  # S1 text translation
    "cu_page_per_1k": 5.00,  # Content Understanding document content extraction, standard pages
    "cu_context_per_1k_tokens": 0.001,  # contextualization tokens; the model tokens are billed by the model
    "cu_audio_per_hour": 0.36,
    "cu_video_per_hour": 1.00,
}


class Refused(RuntimeError):
    """The model, and any fallback model, declined the request."""


def make_client() -> anthropic.Anthropic:
    # Reads ANTHROPIC_API_KEY, or a profile created with `ant auth login`. Requests for the local model, if one is
    # configured, go to the local server instead, and requests for a GPT deployment to Azure OpenAI. A rate-limited
    # request is tried once on another model (local_model.fallback_model).
    return LabClient(anthropic.Anthropic()) if LOCAL_MODEL or GPT_MODELS else anthropic.Anthropic()


def fallback_params(model: str) -> dict[str, Any]:
    """Extra request parameters that switch on server-side refusal fallbacks, when the model supports them."""
    return FALLBACKS if model in FALLBACK_MODELS else {}


def create(client: anthropic.Anthropic, **params: Any):
    """messages.create, with refusal fallbacks switched on where the model supports them."""
    extra = fallback_params(params["model"])
    if extra:
        return client.beta.messages.create(**extra, **params)
    return client.messages.create(**params)


def stream(client: anthropic.Anthropic, **params: Any):
    """messages.stream with the same fallback routing as create(). Use it as a context manager."""
    extra = fallback_params(params["model"])
    if extra:
        return client.beta.messages.stream(**extra, **params)
    return client.messages.stream(**params)


def tool(name: str, description: str, properties: dict) -> dict:
    """A tool definition whose inputs are all required and must match the schema exactly."""
    return {"name": name, "description": description, "strict": True,
            "input_schema": {"type": "object", "properties": properties,
                             "required": list(properties), "additionalProperties": False}}


def text_of(message) -> str:
    """The visible text of a response. Thinking and fallback blocks are skipped."""
    return "".join(block.text for block in message.content if block.type == "text")


def ensure_answered(message) -> None:
    """Raise if the response is a refusal or was cut off."""
    if message.stop_reason == "refusal":
        details = getattr(message, "stop_details", None)
        category = getattr(details, "category", None) if details else None
        raise Refused(f"The model declined this request{f' (category: {category})' if category else ''}.")
    if message.stop_reason == "max_tokens":
        raise RuntimeError("The response hit max_tokens and was cut off. Raise max_tokens and try again.")


def cache_tokens(usage) -> tuple[int, int]:
    """Tokens written to and read from the prompt cache, as (write, read). Zero when the response has none."""
    return (getattr(usage, "cache_creation_input_tokens", None) or 0,
            getattr(usage, "cache_read_input_tokens", None) or 0)


def cost_usd(usage, model: str) -> float | None:
    """Estimated cost of one response at list prices. None when the model's price is unknown.

    If a fallback model served the request, the real bill uses that model's prices.
    """
    price = PRICES.get(model)
    if price is None:
        return None
    cache_write, cache_read = cache_tokens(usage)
    return (
        usage.input_tokens * price["input"]
        + cache_write * price["input"] * CACHE_WRITE_MULTIPLIER
        + cache_read * price["cache_read"]
        + usage.output_tokens * price["output"]
    ) / 1_000_000


def describe_usage(usage, model: str) -> str:
    cost = cost_usd(usage, model)
    parts = [f"input {usage.input_tokens:,}"]
    cache_write, cache_read = cache_tokens(usage)
    if cache_write or cache_read:
        parts += [f"cache write {cache_write:,}", f"cache read {cache_read:,}"]
    parts.append(f"output {usage.output_tokens:,}")
    parts.append(f"${cost:.4f}" if cost is not None else "cost unknown")
    return " · ".join(parts)


def proportion_ci(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson score interval for a success rate. Stays sensible at 0% or 100% and with few cases."""
    if n == 0:
        return (0.0, 0.0)
    p = successes / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return max(0.0, centre - half), min(1.0, centre + half)


def model_argument(parser: argparse.ArgumentParser, claude_only: bool = False) -> None:
    """--model. A script that needs something only Claude has passes claude_only, and defaults to CLAUDE_MODEL."""
    default = CLAUDE_MODEL if claude_only else DEFAULT_MODEL
    what = "Claude model id" if claude_only else "model id: a Claude model, a GPT deployment or the local model"
    parser.add_argument("--model", default=default, help=f"{what} (default: {default})")


def run(main: Callable[[], None]) -> None:
    """Run a script's main() and turn common failures into readable messages."""
    try:
        main()
    except Refused as exc:
        print(exc, file=sys.stderr)
        sys.exit(2)
    except (NeedsClaude, ModelUnavailable) as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
    except anthropic.AuthenticationError:
        print("Authentication failed. Check ANTHROPIC_API_KEY, or run `ant auth login`.", file=sys.stderr)
        sys.exit(1)
    except anthropic.PermissionDeniedError as exc:
        print(f"Permission denied: {exc.message}", file=sys.stderr)
        sys.exit(1)
    except anthropic.NotFoundError as exc:
        print(f"Not found: {exc.message}. Check the model id.", file=sys.stderr)
        sys.exit(1)
    except anthropic.RateLimitError:
        print("Rate limited even after the SDK's automatic retries. Wait a minute and try again.", file=sys.stderr)
        sys.exit(1)
    except anthropic.APIStatusError as exc:
        print(f"API error {exc.status_code}: {exc.message}", file=sys.stderr)
        sys.exit(1)
    except anthropic.APIConnectionError:
        print("Could not reach the Claude API. Check your internet connection.", file=sys.stderr)
        sys.exit(1)
    except TypeError as exc:
        if "authentication" in str(exc).lower():
            print("No API credentials found. Set ANTHROPIC_API_KEY, or run `ant auth login`.", file=sys.stderr)
            sys.exit(1)
        raise
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)
        sys.exit(130)
