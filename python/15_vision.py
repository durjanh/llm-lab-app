"""Read a picture with a vision model: the same receipt through Claude and through GPT on Azure OpenAI.

Companion to the Images as Tokens lab. Each reader gets the image and a JSON schema, and must return
the receipt as structured data, so the code never parses free text. Four readers:
- claude:      the Messages API, the image as a base64 block before the text.
- gpt:         Azure OpenAI Chat Completions, the image as a data URL with detail "high".
- gpt-low:     the same with detail "low": one small view of the image, far fewer tokens, small print at risk.
- gpt-responses: the Azure OpenAI Responses API (input_image), with store off so Azure keeps nothing.
Azure uses your Azure login (run `az login`); no keys.

The sample receipt (images/receipt.png) has known answers, so each reader is scored field by field.
Whatever the image, the script also checks the model's sums in code: line totals less discounts must
equal the total. A model can read every number right and still add them up wrong, or the reverse.

    python 15_vision.py                         # the sample receipt, every reader
    python 15_vision.py --only claude gpt-low
    python 15_vision.py --image my-receipt.jpg  # your own receipt: what each reader found, and the sums check
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

from common import cost_usd, create, ensure_answered, make_client, model_argument, run, text_of
from settings import ENV

SAMPLE = Path(__file__).resolve().parent / "images" / "receipt.png"
MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # Claude's limit for one base64 image
READERS = ["claude", "gpt", "gpt-low", "gpt-responses"]

SYSTEM = ("Extract the receipt in the image as data. Use only what is printed. Copy item names as printed. "
          "A discount or offer line is not an item: add it to discounts instead.")
PROMPT = "Extract this receipt."
SCHEMA = {
    "type": "object",
    "properties": {
        "merchant": {"type": "string"},
        "date": {"type": "string", "description": "YYYY-MM-DD"},
        "currency": {"type": "string", "description": "ISO 4217 code, such as GBP"},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "quantity": {"type": "integer"},
                    "line_total": {"type": "number", "description": "quantity times unit price"},
                },
                "required": ["description", "quantity", "line_total"],
                "additionalProperties": False,
            },
        },
        "discounts": {"type": "number", "description": "all discounts added together, as a positive number; 0 if none"},
        "vat": {"type": "number", "description": "the VAT amount; 0 if not shown"},
        "total": {"type": "number"},
    },
    "required": ["merchant", "date", "currency", "items", "discounts", "vat", "total"],
    "additionalProperties": False,
}


def close(a: float, b: float) -> bool:
    return abs(a - b) < 0.005


def sums_add_up(r: dict) -> bool:
    return close(sum(i["line_total"] for i in r["items"]) - r["discounts"], r["total"])


def score_sample(r: dict) -> list[tuple[str, bool]]:
    """Each field of the sample receipt against what is printed on it."""
    return [
        ("merchant", "harbour lane" in r["merchant"].lower()),
        ("date", r["date"] == "2026-10-14"),  # printed 14/10/2026: day first
        ("currency", r["currency"].upper() == "GBP"),
        ("items", len(r["items"]) == 4),  # the multibuy line is a discount, not an item
        ("quantities", sorted(i["quantity"] for i in r["items"]) == [1, 1, 2, 3]),
        ("discounts", close(r["discounts"], 2.25)),
        ("vat", close(r["vat"], 6.50)),
        ("total", close(r["total"], 38.97)),
        ("sums add up", sums_add_up(r)),
    ]


def read_claude(client, model: str, media_type: str, data: str):
    resp = create(client, model=model, max_tokens=2048, system=SYSTEM,
                  output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
                  messages=[{"role": "user", "content": [
                      {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}},
                      {"type": "text", "text": PROMPT}]}])
    ensure_answered(resp)
    return json.loads(text_of(resp)), resp.usage


def usage_of(input_tokens: int, cached: int, output_tokens: int) -> SimpleNamespace:
    """OpenAI token counts in the shape cost_usd reads. OpenAI's input count includes the cached tokens."""
    return SimpleNamespace(input_tokens=input_tokens - cached, cache_read_input_tokens=cached,
                           cache_creation_input_tokens=0, output_tokens=output_tokens)


def read_gpt_chat(client, deployment: str, media_type: str, data: str, detail: str):
    r = client.chat.completions.create(
        model=deployment, max_completion_tokens=4000, reasoning_effort="low",
        messages=[{"role": "system", "content": SYSTEM},
                  {"role": "user", "content": [
                      {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{data}", "detail": detail}},
                      {"type": "text", "text": PROMPT}]}],
        response_format={"type": "json_schema", "json_schema": {"name": "receipt", "schema": SCHEMA, "strict": True}})
    choice = r.choices[0]
    if choice.message.refusal:
        raise RuntimeError(f"declined: {choice.message.refusal}")
    if choice.finish_reason == "length":
        raise RuntimeError("the answer was cut off")
    cached = getattr(r.usage.prompt_tokens_details, "cached_tokens", 0) or 0
    return json.loads(choice.message.content), usage_of(r.usage.prompt_tokens, cached, r.usage.completion_tokens)


def read_gpt_responses(client, deployment: str, media_type: str, data: str):
    r = client.responses.create(
        model=deployment, instructions=SYSTEM, max_output_tokens=4000, reasoning={"effort": "low"},
        store=False,  # stateless: nothing kept on Azure's side
        input=[{"role": "user", "content": [
            {"type": "input_image", "image_url": f"data:{media_type};base64,{data}", "detail": "high"},
            {"type": "input_text", "text": PROMPT}]}],
        text={"format": {"type": "json_schema", "name": "receipt", "schema": SCHEMA, "strict": True}})
    if r.status != "completed":
        raise RuntimeError(f"status {r.status}: {r.incomplete_details}")
    cached = getattr(r.usage.input_tokens_details, "cached_tokens", 0) or 0
    return json.loads(r.output_text), usage_of(r.usage.input_tokens, cached, r.usage.output_tokens)


def azure_client():
    """Azure OpenAI's v1 endpoint through the OpenAI SDK, with an Entra token instead of a key."""
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider
    from openai import OpenAI

    token = get_bearer_token_provider(DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default")
    return OpenAI(base_url=f"{ENV.azure_openai_endpoint.rstrip('/')}/openai/v1/", api_key=token)


def load_image(path: Path) -> tuple[str, str]:
    media_type = MEDIA_TYPES.get(path.suffix.lower())
    if media_type is None:
        sys.exit(f"{path.name}: use a PNG, JPEG, GIF or WebP image.")
    raw = path.read_bytes()
    if len(raw) > MAX_IMAGE_BYTES:
        sys.exit(f"{path.name} is {len(raw) / 1e6:.1f} MB; make it smaller than 5 MB.")
    return media_type, base64.b64encode(raw).decode()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--image", type=Path, default=SAMPLE, help="a receipt photo or scan (default: the sample)")
    parser.add_argument("--only", nargs="+", choices=READERS, default=READERS, help="which readers to run")
    parser.add_argument("--deployment", default=(ENV.azure_openai_deployments or ("",))[0],
                        help="Azure OpenAI deployment (default: the first in AZURE_OPENAI_DEPLOYMENTS)")
    model_argument(parser)
    args = parser.parse_args()
    media_type, data = load_image(args.image)
    sample = args.image.resolve() == SAMPLE
    print(f"Image: {args.image.name} ({media_type}, {len(data) * 3 // 4 / 1024:.0f} KB)")

    readers: dict[str, tuple[str, callable]] = {}
    if "claude" in args.only:
        client = make_client()
        readers["claude"] = (args.model, lambda: read_claude(client, args.model, media_type, data))
    gpt = [r for r in args.only if r.startswith("gpt")]
    if gpt and not (ENV.azure_openai_endpoint and args.deployment):
        print("Skipping the GPT readers: set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENTS in .env, and run az login.")
    elif gpt:
        azure, dep = azure_client(), args.deployment
        calls = {"gpt": lambda: read_gpt_chat(azure, dep, media_type, data, "high"),
                 "gpt-low": lambda: read_gpt_chat(azure, dep, media_type, data, "low"),
                 "gpt-responses": lambda: read_gpt_responses(azure, dep, media_type, data)}
        readers.update({name: (dep, calls[name]) for name in gpt})

    rows = []
    for name, (model, call) in readers.items():
        print(f"\n=== {name} ({model}) ===")
        start = time.perf_counter()
        try:
            receipt, usage = call()
        except Exception as exc:  # one reader failing should not stop the others
            print(f"  failed: {type(exc).__name__}: {exc}")
            continue
        secs = time.perf_counter() - start
        print(f"  {receipt['merchant']} · {receipt['date']} · {receipt['currency']}")
        for item in receipt["items"]:
            print(f"    {item['quantity']} x {item['description']:<28} {item['line_total']:>8.2f}")
        print(f"  discounts {receipt['discounts']:.2f} · VAT {receipt['vat']:.2f} · total {receipt['total']:.2f}")
        checks = score_sample(receipt) if sample else [("sums add up", sums_add_up(receipt))]
        wrong = [field for field, ok in checks if not ok]
        print(f"  checks: {len(checks) - len(wrong)}/{len(checks)}" + (f", wrong: {', '.join(wrong)}" if wrong else ""))
        rows.append((name, f"{len(checks) - len(wrong)}/{len(checks)}", usage, cost_usd(usage, model), secs))

    if rows:
        print(f"\n{'reader':<14} {'checks':>6} {'input':>7} {'output':>7} {'cost':>9} {'time':>6}")
        for name, checks, usage, cost, secs in rows:
            tokens_in = usage.input_tokens + (usage.cache_read_input_tokens or 0)
            print(f"{name:<14} {checks:>6} {tokens_in:>7,} {usage.output_tokens:>7,} "
                  f"{'$%.5f' % cost if cost is not None else '?':>9} {secs:>5.1f}s")
        print("\nInput counts the image and the prompt; output includes any reasoning tokens. "
              "Image tokens grow with the picture's size, so resize big photos before sending them.")


if __name__ == "__main__":
    run(main)
