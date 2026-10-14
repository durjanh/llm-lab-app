"""Shared helpers for the LLM Lab scripts.

Generation requests go through the SDK's beta endpoint so they can opt into
Anthropic's server-side refusal fallbacks: if the requested model declines a
request on safety grounds, the API re-runs it on a recommended fallback model
instead of returning the refusal. Claude Haiku 5.5 has no server-side fallback,
so its requests use the standard endpoint.
"""
from __future__ import annotations

import argparse
import os
import math
import sys
from typing import Any, Callable

from pathlib import Path

import anthropic


def _load_dotenv() -> None:
    """Read KEY=VALUE lines from a .env file in the project root or this folder.

    Variables already set in the environment win, so a key exported in your
    shell overrides the file. The file is listed in .gitignore; never commit it.
    """
    here = Path(__file__).resolve().parent
    for path in (here.parent / ".env", here / ".env"):
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

DEFAULT_MODEL = os.environ.get("LLM_LAB_MODEL", "claude-opus-5-5")

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
CACHE_WRITE_MULTIPLIER = 1.25  # 5-minute cache entries


class Refused(RuntimeError):
    """The model, and any fallback model, declined the request."""


def make_client() -> anthropic.Anthropic:
    # Reads ANTHROPIC_API_KEY, or a profile created with `ant auth login`.
    return anthropic.Anthropic()


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


def cost_usd(usage, model: str) -> float | None:
    """Estimated cost of one response at list prices. None when the model's price is unknown.

    If a fallback model served the request, the real bill uses that model's prices.
    """
    price = PRICES.get(model)
    if price is None:
        return None
    cache_write = getattr(usage, "cache_creation_input_tokens", None) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", None) or 0
    return (
        usage.input_tokens * price["input"]
        + cache_write * price["input"] * CACHE_WRITE_MULTIPLIER
        + cache_read * price["cache_read"]
        + usage.output_tokens * price["output"]
    ) / 1_000_000


def describe_usage(usage, model: str) -> str:
    cost = cost_usd(usage, model)
    parts = [f"input {usage.input_tokens:,}"]
    cache_write = getattr(usage, "cache_creation_input_tokens", None) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", None) or 0
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


def model_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Claude model id (default: {DEFAULT_MODEL})")


def run(main: Callable[[], None]) -> None:
    """Run a script's main() and turn common failures into readable messages."""
    try:
        main()
    except Refused as exc:
        print(exc, file=sys.stderr)
        sys.exit(2)
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
