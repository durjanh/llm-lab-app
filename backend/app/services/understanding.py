"""Content Understanding and vision: documents, photos, audio and video, read by Foundry Tools and a multimodal model.

Content Understanding turns a file into Markdown for retrieval and into fields with confidence scores and the box
each value came from. Prebuilt analyzers cover common cases; custom analyzers add a field schema with three
methods (extract what is printed, classify into a fixed list, generate what has to be worked out). Agentic mode,
in preview, reasons over the evidence and costs more. Beside it, gpt-5.4-mini does the multimodal tasks a model
is better at: captions, alt text, answers grounded in what the picture shows, regions, and visual policy checks.
"""
from __future__ import annotations

import base64
import re
import threading
import time
from pathlib import Path
from typing import Any

from ..core.errors import ApiError
from ..gateways.foundry_tools import CU_PREVIEW_API, FoundryTools
from ..shared import PRICES, TOOL_PRICES
from . import understanding_samples as samples
from .spend import SpendTracker

MODEL = "gpt-5.4-mini"
CU_MODEL = "gpt-4.1-mini"
FILES = {**{k: (f"{k}.png", "image/png", "document") for k in samples.DOCUMENTS},
         **{k: (f"{k}.png", "image/png", "image") for k in samples.PHOTOS},
         "video": ("claim-video.mp4", "video/mp4", "video"), "audio": ("narration.wav", "audio/wav", "audio")}

_DOC = {"returnDetails": True, "enableOcr": True, "enableLayout": True, "estimateFieldSourceAndConfidence": True}
CUSTOM: dict[str, dict] = {
    "labInvoice": {"kind": "document", "label": "Custom: invoice fields",
                   "about": "Your own schema on prebuilt-document: extract printed values, classify the spend, generate a summary.",
                   "definition": {"baseAnalyzerId": "prebuilt-document", "models": {"completion": CU_MODEL}, "config": _DOC,
                                  "fieldSchema": {"name": "LabInvoice", "fields": {
                                      "InvoiceNumber": {"type": "string", "method": "extract", "description": "The invoice number"},
                                      "InvoiceDate": {"type": "date", "method": "extract", "description": "The date the invoice was issued"},
                                      "Supplier": {"type": "string", "method": "extract", "description": "The company that issued the invoice"},
                                      "Subtotal": {"type": "number", "method": "extract", "description": "Subtotal before VAT, as printed"},
                                      "Total": {"type": "number", "method": "extract", "description": "Total due including VAT, as printed"},
                                      "LineItems": {"type": "array", "method": "extract", "description": "Each line of the invoice table",
                                                    "items": {"type": "object", "properties": {
                                                        "Description": {"type": "string"}, "Quantity": {"type": "number"},
                                                        "Amount": {"type": "number"}}}},
                                      "Category": {"type": "string", "method": "classify", "description": "What the invoice is for",
                                                   "enum": ["building materials", "labour", "mixed", "other"]},
                                      "OneLineSummary": {"type": "string", "method": "generate",
                                                         "description": "One sentence saying what was bought"}}}}},
    "labClaim": {"kind": "document", "label": "Custom: insurance claim",
                 "about": "Form fields, the ticked box as a category, and generated triage notes.",
                 "definition": {"baseAnalyzerId": "prebuilt-document", "models": {"completion": CU_MODEL}, "config": _DOC,
                                "fieldSchema": {"name": "LabClaim", "fields": {
                                    "PolicyNumber": {"type": "string", "method": "extract", "description": "The policy number"},
                                    "Policyholder": {"type": "string", "method": "extract", "description": "The policyholder's name"},
                                    "IncidentDate": {"type": "date", "method": "extract", "description": "The date of the incident"},
                                    "AmountClaimed": {"type": "number", "method": "extract", "description": "The amount claimed in pounds"},
                                    "DamageType": {"type": "string", "method": "classify", "description": "The box ticked under type of damage",
                                                   "enum": ["escape of water", "fire or smoke", "storm", "theft", "accidental damage"]},
                                    "Signed": {"type": "boolean", "method": "extract", "description": "Whether the declaration is signed"},
                                    "Cause": {"type": "string", "method": "generate", "description": "The cause of the damage in a few words"},
                                    "FollowUps": {"type": "string", "method": "generate",
                                                  "description": "What a claims handler should check next, in one sentence"}}}}},
    "labDamage": {"kind": "image", "label": "Custom: damage photo",
                  "about": "Visual characteristics as fields: what is damaged, how badly, and where.",
                  "definition": {"baseAnalyzerId": "prebuilt-image", "models": {"completion": CU_MODEL}, "config": {},
                                 "fieldSchema": {"name": "LabDamage", "fields": {
                                     "Subject": {"type": "string", "method": "generate", "description": "What the photo shows, in a few words"},
                                     "DamageVisible": {"type": "boolean", "method": "generate", "description": "Whether any damage is visible"},
                                     "DamageType": {"type": "string", "method": "classify", "description": "The main kind of damage",
                                                    "enum": ["water", "fire", "impact", "wear", "none"]},
                                     "Severity": {"type": "string", "method": "classify", "description": "How bad the damage looks",
                                                  "enum": ["none", "minor", "moderate", "severe"]},
                                     "Location": {"type": "string", "method": "generate", "description": "Where in the picture the damage is"}}}}},
    "labTotalsStandard": {"kind": "document", "label": "Sum check: standard", "about": "Generate fields that need arithmetic, in the GA API.",
                          "definition": {"baseAnalyzerId": "prebuilt-document", "models": {"completion": CU_MODEL}, "config": {"returnDetails": True},
                                         "fieldSchema": {"name": "LabTotals", "fields": {
                                             "LineSum": {"type": "number", "method": "generate", "description": "The sum of every line amount in the table, calculated"},
                                             "PrintedSubtotal": {"type": "number", "method": "generate", "description": "The subtotal as printed on the invoice"},
                                             "TotalsAddUp": {"type": "boolean", "method": "generate", "description": "True only if the line amounts add up exactly to the printed subtotal"},
                                             "Explanation": {"type": "string", "method": "generate", "description": "One sentence showing the calculation"}}}}},
}
CUSTOM["labTotalsAgentic"] = {"kind": "document", "label": "Sum check: agentic (preview)", "api": CU_PREVIEW_API,
                              "about": "The same fields with workflow agentic: more reasoning, more tokens, the advanced rate.",
                              "definition": {**CUSTOM["labTotalsStandard"]["definition"],
                                             "config": {"returnDetails": True, "workflow": "agentic"}}}
PREBUILT = {
    "prebuilt-read": ("document", "Read: OCR text only"),
    "prebuilt-layout": ("document", "Layout: text, tables, sections and figures as Markdown"),
    "prebuilt-documentSearch": ("document", "Document search: Markdown plus a summary, for RAG"),
    "prebuilt-invoice": ("document", "Invoice (domain prebuilt): needs gpt-4.1 or larger, so it is refused here"),
    "prebuilt-imageSearch": ("image", "Image search: a description for retrieval"),
    "prebuilt-audioSearch": ("audio", "Audio search: transcript with speakers and a summary"),
    "prebuilt-videoSearch": ("video", "Video search: transcript, key frames, shots and a summary"),
}

VISION_TASKS = {
    "concise": "Caption this image in one short sentence of at most 15 words.",
    "detailed": "Describe this image in detail in one paragraph: the subject, the setting, notable objects, colours, any text, and anything unusual.",
    "alt": ("Write alt text for this image for a web page, following WCAG guidance: convey its content and purpose in at most "
            "125 characters, do not start with 'image of' or 'picture of', and do not repeat surrounding text."),
    "extended": ("Write an extended description for someone who cannot see this image, for a long description link: "
                 "what it shows from top to bottom and left to right, any text in full, and why it matters. 80 to 150 words."),
    "compare": "These images are from one insurance claim. In a short paragraph, say what each shows and what they tell a claims handler together.",
}
REGIONS_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["regions"], "properties": {"regions": {
    "type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["label", "box"],
                               "properties": {"label": {"type": "string"},
                                              "box": {"type": "array", "items": {"type": "integer"}, "description": "x0, y0, x1, y1 on a 0 to 1000 scale"}}}}}}
VQA_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["answer", "answerable", "evidence"], "properties": {
    "answer": {"type": "string"}, "answerable": {"type": "boolean", "description": "false if the picture does not show enough to answer"},
    "evidence": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["what", "box"],
                                            "properties": {"what": {"type": "string"}, "box": {"type": "array", "items": {"type": "integer"}}}}}}}
POLICY_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["checks"], "properties": {"checks": {
    "type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["rule", "passed", "evidence"],
                               "properties": {"rule": {"type": "string"}, "passed": {"type": "boolean"}, "evidence": {"type": "string"}}}}}}
POLICY_RULES = ["No real brand names or logos are visible", "Any price shown is in pounds sterling",
                "No people's faces can be identified", "No weapons, drugs or hateful symbols", "Any text in the image is legible"]

SOURCE = re.compile(r"D\((\d+),([\d.,]+)\)")


def boxes(source: str) -> list[dict]:
    """'D(page,x1,y1,...,x4,y4);D(...)' as page and polygon points."""
    out = []
    for page, nums in SOURCE.findall(source or ""):
        v = [float(n) for n in nums.split(",")]
        out.append({"page": int(page), "points": [[v[i], v[i + 1]] for i in range(0, len(v) - 1, 2)]})
    return out


def value(field: dict) -> Any:
    """A field's value, simplified: arrays and objects as plain lists and dicts."""
    t = field.get("type")
    if t == "array":
        return [value(x) for x in field.get("valueArray", [])]
    if t == "object":
        return {k: value(v) for k, v in field.get("valueObject", {}).items()}
    return next((v for k, v in field.items() if k.startswith("value")), None)


class UnderstandingService:
    def __init__(self, tools: FoundryTools | None, spend: SpendTracker, folder: Path):
        self.tools, self.spend, self.folder = tools, spend, folder
        self._ready: set[str] = set()
        self._lock = threading.Lock()

    def _tools(self) -> FoundryTools:
        if self.tools is None:
            raise ApiError(503, "not_configured", "Set AZURE_LANGUAGE_ENDPOINT (your AI Services resource in a Content "
                                                  "Understanding region) in .env, run az login, and restart the backend.")
        return self.tools

    # ----- the sample files -----
    def _path(self, name: str) -> Path:
        if name not in FILES:
            raise ApiError(404, "not_found", f"No sample called {name}.")
        return self.folder / FILES[name][0]

    def media(self, name: str) -> tuple[bytes, str]:
        p = self._path(name)
        if not p.exists() and name in samples.DOCUMENT_MAKERS:
            self.folder.mkdir(parents=True, exist_ok=True)
            p.write_bytes(samples.DOCUMENT_MAKERS[name]())
        if not p.exists():
            raise ApiError(404, "not_prepared", "This sample has not been made yet. Press 'Make the sample media'.")
        return p.read_bytes(), FILES[name][1]

    def info(self) -> dict[str, Any]:
        labels = {**samples.DOCUMENTS, **{k: v[0] for k, v in samples.PHOTOS.items()}, "video": "Claim video (15 s, narrated)",
                  "audio": "Claim narration (audio only)"}
        return {"configured": self.tools is not None, "model": MODEL, "cu_model": CU_MODEL,
                "samples": [{"id": k, "label": labels[k], "kind": FILES[k][2],
                             "ready": k in samples.DOCUMENT_MAKERS or self._path(k).exists()} for k in FILES],
                "analyzers": [{"id": k, "kind": v[0], "label": v[1], "custom": False} for k, v in PREBUILT.items()]
                             + [{"id": k, "kind": v["kind"], "label": v["label"], "about": v["about"], "custom": True,
                                 "schema": v["definition"].get("fieldSchema", {}).get("fields", {})} for k, v in CUSTOM.items()],
                "tasks": list(VISION_TASKS) + ["vqa", "regions", "policy"], "policy_rules": POLICY_RULES,
                "narration": samples.NARRATION, "prices": TOOL_PRICES}

    def prepare(self) -> dict[str, Any]:
        """Makes any missing photos (gpt-image-2, waiting out its rate limit), then the video and the audio."""
        tools = self._tools()
        self.folder.mkdir(parents=True, exist_ok=True)
        made, cost = [], 0.0
        for name, (_, prompt) in samples.PHOTOS.items():
            p = self._path(name)
            for _ in range(6):
                if p.exists():
                    break
                try:
                    r = tools.generate_image(prompt, size="1536x1024", quality="medium", n=1, output_format="png")
                except ApiError as exc:
                    if exc.status != 429:
                        raise
                    time.sleep(30)
                    continue
                p.write_bytes(base64.b64decode(r["data"][0]["b64_json"]))
                u = r.get("usage") or {}
                cost += self.spend.charge_usd((u.get("input_tokens", 0) * PRICES["gpt-image-2"]["input"]
                                               + u.get("output_tokens", 0) * PRICES["gpt-image-2"]["output"]) / 1e6, "gpt-image-2")
                made.append(name)
        if not self._path("video").exists() and samples.make_video([self._path(n) for n in samples.PHOTOS], self._path("video")):
            made.append("video")
        if not self._path("audio").exists() and samples.make_audio(self._path("audio")):
            made.append("audio")
        return {"made": made, "cost_usd": round(cost, 6), **self.info()}

    # ----- Content Understanding -----
    def _ensure(self, analyzer: str) -> None:
        with self._lock:
            if analyzer in self._ready:
                return
            spec = CUSTOM[analyzer]
            self._tools().cu_put_analyzer(analyzer, {"description": spec["about"], **spec["definition"]},
                                          spec.get("api", "2025-11-01"))
            self._ready.add(analyzer)

    def analyze(self, sample: str, analyzer: str) -> dict[str, Any]:
        kind = FILES.get(sample, (None, None, None))[2]
        want = PREBUILT[analyzer][0] if analyzer in PREBUILT else CUSTOM[analyzer]["kind"] if analyzer in CUSTOM else None
        if want is None:
            raise ApiError(400, "invalid_request", f"No analyzer called {analyzer}.")
        if kind != want:
            raise ApiError(400, "invalid_request", f"{analyzer} reads {want} files; {sample} is a {kind}.")
        data, mime = self.media(sample)
        if analyzer in CUSTOM:
            self._ensure(analyzer)
        api = CUSTOM.get(analyzer, {}).get("api", "2025-11-01")
        started = time.perf_counter()
        r = self._tools().cu_analyze(analyzer, data, mime, timeout_s=300, api_version=api)
        seconds = round(time.perf_counter() - started, 1)
        return {**self._shape(r), "analyzer": analyzer, "sample": sample, "seconds": seconds,
                "cost_usd": self._charge_cu(r, kind), "spent_usd": self.spend.spent_usd}

    def _shape(self, r: dict) -> dict[str, Any]:
        c = (r.get("contents") or [{}])[0]
        pages = [{"width": p.get("width"), "height": p.get("height")} for p in c.get("pages", [])]
        fields = [{"name": k, "type": f.get("type"), "value": value(f), "confidence": f.get("confidence"),
                   "boxes": boxes(f.get("source", ""))} for k, f in (c.get("fields") or {}).items()]
        for f in fields:  # array items carry their own boxes: collect them so the page can draw every line
            raw = (c.get("fields") or {}).get(f["name"], {})
            if raw.get("type") == "array":
                f["item_boxes"] = [sum((boxes(v.get("source", "")) for v in item.get("valueObject", {}).values()), [])
                                   for item in raw.get("valueArray", [])]
        return {"kind": c.get("kind"), "markdown": c.get("markdown", ""), "unit": c.get("unit"), "pages": pages,
                "fields": fields, "tables": len(c.get("tables", [])), "paragraphs": len(c.get("paragraphs", [])),
                "words": sum(len(p.get("words", [])) for p in c.get("pages", [])),
                "transcript": [{"speaker": t.get("speaker"), "start": t.get("startTimeMs"), "end": t.get("endTimeMs"),
                                "text": t.get("text"), "confidence": t.get("confidence")} for t in c.get("transcriptPhrases", [])],
                "keyframes": c.get("KeyFrameTimesMs") or c.get("keyFrameTimesMs") or [],
                "shots": c.get("cameraShotTimesMs") or [], "duration_ms": c.get("endTimeMs"), "usage": r.get("usage") or {}}

    def _charge_cu(self, r: dict, kind: str | None) -> float:
        """Content extraction, contextualization and model tokens, from the usage the service reports."""
        u = r.get("usage") or {}
        cost = (u.get("documentPagesStandard", 0) + u.get("documentPagesMinimal", 0) + u.get("documentPagesBasic", 0)) \
            * TOOL_PRICES["cu_page_per_1k"] / 1000
        cost += u.get("contextualizationTokens", 0) * TOOL_PRICES["cu_context_per_1k_tokens"] / 1000
        cost += u.get("advancedContextualizationTokens", 0) * TOOL_PRICES["cu_context_per_1k_tokens"] * 3 / 1000
        for key, n in (u.get("tokens") or {}).items():
            model = key.rsplit("-", 1)[0].replace("-cached", "")
            price = PRICES.get(model) or PRICES.get(key.split("-input")[0].split("-output")[0].replace("-cached", ""))
            if price:
                rate = price["cache_read"] if "cached" in key else price["output"] if key.endswith("output") else price["input"]
                cost += n * rate / 1e6
        if kind in ("audio", "video"):
            c = (r.get("contents") or [{}])[0]
            hours = ((c.get("endTimeMs") or 0) - (c.get("startTimeMs") or 0)) / 3_600_000
            cost += hours * TOOL_PRICES["cu_video_per_hour" if kind == "video" else "cu_audio_per_hour"]
        return self.spend.charge_usd(cost, "Content Understanding")

    # ----- a multimodal model on the same pictures -----
    def vision(self, images: list[str], task: str, question: str) -> dict[str, Any]:
        if not images or any(FILES.get(i, ("", "", ""))[2] not in ("image", "document") for i in images):
            raise ApiError(400, "invalid_request", "Choose one or more photos or documents.")
        parts: list[dict] = []
        for name in images:
            data, mime = self.media(name)
            parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}",
                                                             "detail": "high"}})
        schema = None
        if task in VISION_TASKS:
            prompt = VISION_TASKS[task]
        elif task == "vqa":
            prompt = (f"Answer the question using only what the image shows. Give the evidence as boxes on a 0 to 1000 "
                      f"scale (x0, y0, x1, y1). If the image does not show enough, say so and set answerable false.\n\n"
                      f"Question: {question}")
            schema = ("vqa", VQA_SCHEMA)
        elif task == "regions":
            prompt = ("List the main objects and regions in the image with tight boxes on a 0 to 1000 scale (x0, y0, x1, y1), "
                      "at most 8, most important first." + (f" Focus on: {question}" if question else ""))
            schema = ("regions", REGIONS_SCHEMA)
        elif task == "policy":
            prompt = "Check this image against each rule. Say for each whether it passes, with brief evidence.\n" + \
                     "\n".join(f"- {r}" for r in POLICY_RULES)
            schema = ("policy", POLICY_SCHEMA)
        else:
            raise ApiError(400, "invalid_request", f"No task called {task}.")
        params: dict[str, Any] = {"max_completion_tokens": 900}
        if schema:
            params["response_format"] = {"type": "json_schema", "json_schema": {"name": schema[0], "schema": schema[1], "strict": True}}
        started = time.perf_counter()
        r = self._tools().chat(MODEL, [{"role": "user", "content": [{"type": "text", "text": prompt}, *parts]}], **params)
        text = r["choices"][0]["message"]["content"] or ""
        u = r.get("usage") or {}
        cost = self.spend.charge_usd((u.get("prompt_tokens", 0) * PRICES[MODEL]["input"]
                                      + u.get("completion_tokens", 0) * PRICES[MODEL]["output"]) / 1e6, MODEL)
        out: dict[str, Any] = {"task": task, "text": text, "prompt": prompt, "seconds": round(time.perf_counter() - started, 1),
                               "tokens": {"input": u.get("prompt_tokens"), "output": u.get("completion_tokens")},
                               "cost_usd": round(cost, 6), "spent_usd": self.spend.spent_usd}
        if schema:
            import json

            out["data"] = json.loads(text)
        return out
