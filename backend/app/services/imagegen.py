"""Image generation with gpt-image-2: from a prompt, from reference images, and with a mask (inpainting).

Generated images are saved in generated/images (ignored by git) so they can be edited again. Each one is checked
for Content Credentials (C2PA), the signed provenance record Azure OpenAI embeds in what it generates, and can be
given a visible watermark and checked against visual policy rules by a multimodal model. The deployment has a
small rate limit; a 429 is waited out, up to a minute, and the wait is reported. Video generation is explained,
not run: Sora 2 was closed to new deployments on 2 November 2026 with no replacement in Foundry.
"""
from __future__ import annotations

import base64
import io
import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from ..core.errors import ApiError
from ..gateways.foundry_tools import FoundryTools
from ..shared import IMAGE_INPUT_PRICE_PER_M, PRICES
from .guardrail_samples import _font
from .spend import SpendTracker
from .understanding import POLICY_SCHEMA

SIZES = ["1024x1024", "1536x1024", "1024x1536"]
QUALITIES = ["low", "medium", "high"]
BACKGROUNDS = ["auto", "opaque", "transparent"]
CHECK_MODEL = "gpt-5.4-mini"
BRAND_RULES = ["No real brand names, logos or trademarks are visible", "No real, identifiable people",
               "Nothing violent, sexual, hateful or dangerous", "Colours are calm and suitable for a household insurer's leaflet",
               "Any text in the image is spelled correctly"]
PROMPTS = [
    {"label": "Leaflet illustration", "prompt": "A friendly flat illustration for a home insurance leaflet: a plumber fixing "
                                                "a leaking pipe under a kitchen sink, soft blues and greens, no text"},
    {"label": "Product shot, transparent", "prompt": "A single white smart water-leak sensor, a small rounded puck with one "
                                                     "blue light, studio product shot", "background": "transparent"},
    {"label": "Text in the image", "prompt": "A shop window poster that reads 'WINTER BOILER CHECKS £49', bold clean "
                                             "typography, navy and white"},
]
VIDEO = {
    "status": "Not runnable: Sora 2 (version 2025-12-08) was deprecated for new deployments on 2 November 2026 and no "
              "replacement video model is listed in Foundry.",
    "facts": ["Asynchronous: create a job, poll its status, then download the MP4 (jobs are kept 24 hours).",
              "Text to video, image to video (a reference image that must match the output size), and remix: a targeted "
              "edit of a finished video by its id, keeping its structure and motion.",
              "Sizes such as 720x1280 and 1280x720; 4, 8 or 12 seconds; audio is generated too; billed per second.",
              "Two jobs at a time per deployment; input and output moderation as with images."],
    "code": '''from openai import OpenAI
from azure.identity import DefaultAzureCredential, get_bearer_token_provider

token = get_bearer_token_provider(DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default")
client = OpenAI(base_url="https://<resource>.openai.azure.com/openai/v1/", api_key=token)

video = client.videos.create(model="sora-2", prompt="A slow pan across a repaired kitchen ceiling, morning light",
                             size="1280x720", seconds="8")
while video.status in ("queued", "in_progress"):
    time.sleep(10)
    video = client.videos.retrieve(video.id)
client.videos.download_content(video.id, variant="video").write_to_file("ceiling.mp4")

# Edit the generated video: one targeted change, the rest kept
remix = client.videos.remix(video_id=video.id, prompt="Make the light warmer, late afternoon")''',
}


def has_c2pa(png: bytes) -> bool:
    """Content Credentials live in a 'caBX' chunk of a PNG, as a JUMBF box labelled c2pa."""
    return b"caBX" in png or b"c2pa" in png


class ImageGenService:
    def __init__(self, tools: FoundryTools | None, spend: SpendTracker, folder: Path, samples_folder: Path):
        self.tools, self.spend, self.folder, self.samples_folder = tools, spend, folder, samples_folder
        self._lock = threading.Lock()  # one request at a time: the deployment allows very few per minute

    def _tools(self) -> FoundryTools:
        if self.tools is None or not self.tools.media_endpoint:
            raise ApiError(503, "not_configured", "Set AZURE_MEDIA_ENDPOINT in .env (an AI Services resource with a "
                                                  "gpt-image-2 deployment), run az login, and restart the backend.")
        return self.tools

    # ----- the gallery -----
    def _path(self, ref: str) -> Path:
        if ref.startswith("sample:"):
            p = self.samples_folder / f"{ref[7:]}.png"
        elif re.fullmatch(r"[0-9a-f]{12}(-wm)?", ref):
            p = self.folder / f"{ref}.png"
        else:
            raise ApiError(400, "invalid_request", f"No image called {ref}.")
        if not p.exists():
            raise ApiError(404, "not_found", f"{ref} has not been made yet.")
        return p

    def image(self, ref: str) -> bytes:
        return self._path(ref).read_bytes()

    def _save(self, png: bytes, meta: dict) -> dict:
        self.folder.mkdir(parents=True, exist_ok=True)
        image_id = uuid.uuid4().hex[:12]
        (self.folder / f"{image_id}.png").write_bytes(png)
        meta = {**meta, "id": image_id, "c2pa": has_c2pa(png), "bytes": len(png), "made_at": time.strftime("%H:%M:%S")}
        (self.folder / f"{image_id}.json").write_text(json.dumps(meta))
        return meta

    def gallery(self) -> list[dict]:
        if not self.folder.exists():
            return []
        items = [json.loads(p.read_text()) for p in self.folder.glob("*.json")]
        return sorted(items, key=lambda m: (self.folder / f"{m['id']}.png").stat().st_mtime, reverse=True)[:24]

    def info(self) -> dict[str, Any]:
        samples = [p.stem for p in self.samples_folder.glob("*.png") if p.stem in ("ceiling", "shelf", "street")] \
            if self.samples_folder.exists() else []
        return {"configured": self.tools is not None and bool(self.tools.media_endpoint), "model": "gpt-image-2",
                "sizes": SIZES, "qualities": QUALITIES, "backgrounds": BACKGROUNDS, "prompts": PROMPTS,
                "gallery": self.gallery(), "samples": samples, "rules": BRAND_RULES, "video": VIDEO,
                "prices": {"text_input_per_m": PRICES["gpt-image-2"]["input"], "image_input_per_m": IMAGE_INPUT_PRICE_PER_M,
                           "output_per_m": PRICES["gpt-image-2"]["output"]}}

    # ----- calls, with the rate limit waited out -----
    def _call(self, fn: Any) -> tuple[dict, float]:
        waited = 0.0
        with self._lock:
            for _ in range(4):
                try:
                    return fn(), waited
                except ApiError as exc:
                    if exc.status != 429 or waited > 60:
                        raise
                    m = re.search(r"retry after (\d+)", exc.message)
                    pause = min(int(m.group(1)) + 1 if m else 20, 65)
                    time.sleep(pause)
                    waited += pause
        raise ApiError(429, "rate_limited", "gpt-image-2 is still rate limited. Try again in a minute.")

    def _charge(self, usage: dict) -> float:
        d = usage.get("input_tokens_details") or {}
        text_in = d.get("text_tokens", usage.get("input_tokens", 0))
        image_in = d.get("image_tokens", 0)
        cost = (text_in * PRICES["gpt-image-2"]["input"] + image_in * IMAGE_INPUT_PRICE_PER_M
                + usage.get("output_tokens", 0) * PRICES["gpt-image-2"]["output"]) / 1e6
        return self.spend.charge_usd(cost, "gpt-image-2")

    def _result(self, r: dict, meta: dict, started: float, waited: float) -> dict[str, Any]:
        usage = r.get("usage") or {}
        cost = self._charge(usage)
        items = [self._save(base64.b64decode(d["b64_json"]), {**meta, "revised_prompt": d.get("revised_prompt")})
                 for d in r.get("data", [])]
        return {"items": items, "usage": usage, "cost_usd": round(cost, 6), "seconds": round(time.perf_counter() - started - waited, 1),
                "waited_s": waited, "spent_usd": self.spend.spent_usd}

    def generate(self, prompt: str, size: str, quality: str, background: str, n: int) -> dict[str, Any]:
        tools = self._tools()
        params: dict[str, Any] = {"size": size, "quality": quality, "n": n, "output_format": "png"}
        if background != "auto":
            params["background"] = background
        started = time.perf_counter()
        r, waited = self._call(lambda: tools.generate_image(prompt, **params))
        return self._result(r, {"kind": "generated", "prompt": prompt, **params}, started, waited)

    def edit(self, prompt: str, refs: list[str], mask: str, size: str, quality: str) -> dict[str, Any]:
        """Reference images guide the result. With a mask, only its transparent pixels may change (inpainting); the
        mask must be the same size as the first image, so it is resized to fit."""
        tools = self._tools()
        images = [self._path(ref).read_bytes() for ref in refs]
        mask_png = None
        if mask:
            first = Image.open(io.BytesIO(images[0]))
            m = Image.open(io.BytesIO(base64.b64decode(mask.split(",")[-1]))).convert("RGBA").resize(first.size)
            buf = io.BytesIO()
            m.save(buf, "PNG")
            mask_png = buf.getvalue()
        started = time.perf_counter()
        r, waited = self._call(lambda: tools.edit_image(prompt, images, mask_png, size=size, quality=quality,
                                                        output_format="png"))
        return self._result(r, {"kind": "inpainted" if mask else "edited", "prompt": prompt, "from": refs,
                                "size": size, "quality": quality}, started, waited)

    def from_sketch(self, png: bytes, prompt: str, size: str = "1024x1024", quality: str = "low") -> dict[str, Any]:
        """A picture made from a sketch (the whiteboard's), given as the one reference image."""
        tools = self._tools()
        started = time.perf_counter()
        r, waited = self._call(lambda: tools.edit_image(prompt, [png], None, size=size, quality=quality,
                                                        output_format="png"))
        return self._result(r, {"kind": "from sketch", "prompt": prompt, "size": size, "quality": quality}, started, waited)

    # ----- after generation -----
    def watermark(self, ref: str, text: str) -> dict[str, Any]:
        """A visible label in the corner. It does not replace Content Credentials: it survives a screenshot, they do not."""
        img = Image.open(self._path(ref)).convert("RGBA")
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        size = max(18, img.width // 40)
        font = _font(size)
        w = d.textlength(text, font=font)
        x, y = img.width - w - size, img.height - size * 2
        d.rectangle([x - size // 2, y - size // 3, x + w + size // 2, y + size * 1.3], fill=(0, 0, 0, 140))
        d.text((x, y), text, font=font, fill=(255, 255, 255, 235))
        out = Image.alpha_composite(img, layer).convert("RGB")
        buf = io.BytesIO()
        out.save(buf, "PNG")
        meta = self._save(buf.getvalue(), {"kind": "watermarked", "prompt": f"Watermark '{text}'", "from": [ref]})
        return {"item": meta, "note": "Re-encoding with Pillow drops the original Content Credentials: "
                                      + ("they are gone from the copy." if not meta["c2pa"] else "they survived.")}

    def check(self, ref: str) -> dict[str, Any]:
        png = self._path(ref).read_bytes()
        url = "data:image/png;base64," + base64.b64encode(png).decode()
        prompt = "Check this generated image against each rule. Say for each whether it passes, with brief evidence.\n" + \
                 "\n".join(f"- {r}" for r in BRAND_RULES)
        r = self._tools().chat(CHECK_MODEL, [{"role": "user", "content": [{"type": "text", "text": prompt},
                                                                          {"type": "image_url", "image_url": {"url": url}}]}],
                               max_completion_tokens=700,
                               response_format={"type": "json_schema", "json_schema": {"name": "policy", "schema": POLICY_SCHEMA, "strict": True}})
        u = r.get("usage") or {}
        cost = self.spend.charge_usd((u.get("prompt_tokens", 0) * PRICES[CHECK_MODEL]["input"]
                                      + u.get("completion_tokens", 0) * PRICES[CHECK_MODEL]["output"]) / 1e6, CHECK_MODEL)
        return {"checks": json.loads(r["choices"][0]["message"]["content"])["checks"], "c2pa": has_c2pa(png),
                "cost_usd": round(cost, 6), "spent_usd": self.spend.spent_usd}
