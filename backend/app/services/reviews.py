"""The review dashboard: Azure Language reads multilingual product reviews, and Claude can do the same job beside it.

For each review Azure Language detects the language first, then runs sentiment analysis with opinion mining, key
phrase extraction and entity recognition with that language set, because those features otherwise assume
English. Azure bills one text record per feature per started 1,000 characters; each analysis is charged to the
spend tracker and kept, so the same text is never paid for twice in one session. Claude's reading is one
structured-output call per review, charged in tokens.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from ..core.errors import ApiError
from ..gateways.azure_language import API_VERSION, LIMITS, TextAnalyzer
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, LANGUAGE_PRICE_PER_1K_RECORDS, text_of
from .review_samples import CATEGORIES, RETAILER, REVIEWS
from .spend import SpendTracker

FEATURES = ["LanguageDetection", "SentimentAnalysis", "KeyPhraseExtraction", "EntityRecognition"]
# Language detection names Chinese differently from the codes the other features accept.
LANGUAGE_CODES = {"zh_chs": "zh-hans", "zh_cht": "zh-hant"}

CLAUDE_SYSTEM = """You analyse one customer product review for a retailer's dashboard. The review can be in any language.
Report: the language; the overall sentiment (positive, negative, neutral, or mixed when it has clear praise and a clear
complaint); the key phrases customers would search for, in the review's own language and translated into English;
named entities, where a brand or company is Brand, a product or model is Product and a city, country or place is
Location; and each opinion as a target and what was said about it. Translate the review into English. Report only
what the review says."""
CLAUDE_SCHEMA = {
    "type": "object",
    "properties": {
        "language": {"type": "object", "properties": {"name": {"type": "string"}, "iso": {"type": "string"}},
                     "required": ["name", "iso"], "additionalProperties": False},
        "sentiment": {"type": "string", "enum": ["positive", "negative", "neutral", "mixed"]},
        "key_phrases": {"type": "array", "items": {"type": "string"}},
        "key_phrases_english": {"type": "array", "items": {"type": "string"}},
        "entities": {"type": "array", "items": {
            "type": "object",
            "properties": {"text": {"type": "string"},
                           "category": {"type": "string", "enum": ["Product", "Brand", "Location", "Other"]}},
            "required": ["text", "category"], "additionalProperties": False}},
        "opinions": {"type": "array", "items": {
            "type": "object",
            "properties": {"target": {"type": "string"}, "assessment": {"type": "string"},
                           "sentiment": {"type": "string", "enum": ["positive", "negative", "neutral"]}},
            "required": ["target", "assessment", "sentiment"], "additionalProperties": False}},
        "english": {"type": "string"},
    },
    "required": ["language", "sentiment", "key_phrases", "key_phrases_english", "entities", "opinions", "english"],
    "additionalProperties": False,
}


def records(text: str) -> int:
    """Text records one feature bills for one document: one per started 1,000 characters."""
    return max(1, math.ceil(len(text) / 1000))


def opinions(sentence: dict) -> list[dict]:
    """Opinion mining's targets, each with the assessments its relations point at."""
    out = []
    for target in sentence.get("targets", []):
        said = []
        for rel in target.get("relations", []):
            found = re.search(r"/assessments/(\d+)$", rel.get("ref", ""))
            if rel.get("relationType") == "assessment" and found:
                a = sentence["assessments"][int(found.group(1))]
                said.append({"text": a["text"], "sentiment": a["sentiment"], "negated": a.get("isNegated", False)})
        out.append({"target": target["text"], "sentiment": target["sentiment"], "assessments": said})
    return out


class ReviewsService:
    def __init__(self, language: TextAnalyzer | None, claude: ClaudeGateway, spend: SpendTracker):
        self.language, self.claude, self.spend = language, claude, spend
        self.analyses: dict[str, dict] = {}  # by text: what Azure Language returned, so nothing is paid for twice
        self.readings: dict[tuple[str, str], dict] = {}  # by (model, text): what Claude returned
        self.spent_usd = 0.0
        self._lock = threading.Lock()

    def info(self) -> dict[str, Any]:
        return {"configured": self.language is not None, "retailer": RETAILER, "categories": CATEGORIES,
                "reviews": REVIEWS, "price_per_1k_records": LANGUAGE_PRICE_PER_1K_RECORDS, "limits": LIMITS,
                "api_version": API_VERSION, "analysed": {r["id"]: self.analyses[r["text"]]
                                                         for r in REVIEWS if r["text"] in self.analyses},
                "spent_usd": self.spent_usd}

    def _items(self, ids: list[str] | None, text: str | None) -> list[tuple[str, str]]:
        if text:
            return [(f"custom-{hashlib.sha256(text.encode()).hexdigest()[:8]}", text)]
        by_id = {r["id"]: r["text"] for r in REVIEWS}
        unknown = [i for i in ids or [] if i not in by_id]
        if unknown:
            raise ApiError(404, "not_found", f"No review with id {', '.join(unknown)}.")
        return [(i, by_id[i]) for i in (ids or list(by_id))]

    def analyze(self, ids: list[str] | None = None, text: str | None = None) -> dict[str, Any]:
        """Azure Language's four features over the reviews (all of them by default) or one pasted text."""
        if self.language is None:
            raise ApiError(503, "not_configured", "Set AZURE_LANGUAGE_ENDPOINT in .env, run az login, and restart "
                                                  "the backend.")
        items = self._items(ids, text)
        new = [(i, t) for i, t in items if t not in self.analyses]
        report: dict[str, Any] = {"requests": {}, "model_versions": {}, "records": 0, "cost_usd": 0.0}
        if new:
            report = self._run(new)
        return {"analyses": {i: self.analyses[t] for i, t in items}, "analysed": len(new),
                "reused": len(items) - len(new), **report, "spent_usd": self.spent_usd}

    def _run(self, items: list[tuple[str, str]]) -> dict[str, Any]:
        texts = dict(items)
        detected = self.language.analyze("LanguageDetection", [{"id": i, "text": t} for i, t in items])
        found = {d["id"]: d["detectedLanguage"] for d in detected["documents"]}
        sent_as = {i: LANGUAGE_CODES.get(found[i]["iso6391Name"], found[i]["iso6391Name"]) if i in found else "en"
                   for i, _ in items}
        sent_as = {i: "en" if code == "(Unknown)" else code for i, code in sent_as.items()}
        docs = [{"id": i, "language": sent_as[i], "text": t} for i, t in items]
        with ThreadPoolExecutor(max_workers=3) as pool:
            sentiment, phrases, entities = pool.map(lambda job: self.language.analyze(*job), [
                ("SentimentAnalysis", docs, {"opinionMining": True}),
                ("KeyPhraseExtraction", docs, None),
                ("EntityRecognition", docs, None)])
        results = {"LanguageDetection": detected, "SentimentAnalysis": sentiment,
                   "KeyPhraseExtraction": phrases, "EntityRecognition": entities}

        billed = sum(records(t) for _, t in items) * len(FEATURES)
        cost = billed * LANGUAGE_PRICE_PER_1K_RECORDS / 1000
        self.spend.charge_usd(cost, f"Azure Language, {billed} text records")
        by_kind = {kind: {d["id"]: d for d in r["documents"]} for kind, r in results.items()}
        failed = {kind: {e["id"]: e["error"].get("message", "") for e in r["errors"]} for kind, r in results.items()}
        with self._lock:
            self.spent_usd += cost
            for i, text in items:
                self.analyses[text] = self._shape(i, sent_as[i], by_kind, failed)
        return {"requests": {k: r["requests"] for k, r in results.items()},
                "model_versions": {k: r["model_version"] for k, r in results.items()},
                "records": billed, "cost_usd": cost}

    @staticmethod
    def _shape(i: str, sent_as: str, by_kind: dict, failed: dict) -> dict[str, Any]:
        """One review's results from the four features, in the shape the page shows."""
        problems = [f"{kind}: {failed[kind][i]}" for kind in FEATURES if i in failed[kind]]
        problems += [f"{kind}: {w['message']}" for kind in FEATURES for w in by_kind[kind].get(i, {}).get("warnings", [])]
        lang = by_kind["LanguageDetection"].get(i, {}).get("detectedLanguage")
        s = by_kind["SentimentAnalysis"].get(i)
        return {
            "language": lang and {"name": lang["name"].replace("_", " "), "iso": lang["iso6391Name"],
                                  "confidence": lang["confidenceScore"], "script": lang.get("scriptName", "")},
            "sent_as": sent_as,
            "sentiment": s and {"label": s["sentiment"], "scores": s["confidenceScores"], "sentences": [
                {"text": x["text"].strip(), "label": x["sentiment"], "scores": x["confidenceScores"],
                 "opinions": opinions(x)} for x in s["sentences"]]},
            "key_phrases": by_kind["KeyPhraseExtraction"].get(i, {}).get("keyPhrases", []),
            "entities": [{"text": e["text"], "category": e["category"], "subcategory": e.get("subcategory", ""),
                          "confidence": e["confidenceScore"]}
                         for e in by_kind["EntityRecognition"].get(i, {}).get("entities", [])],
            "problems": problems,
        }

    def compare(self, review_id: str | None, text: str | None, model: str | None) -> dict[str, Any]:
        """Claude reads the same review in one structured-output call: the same fields, plus an English translation."""
        model = model or DEFAULT_MODEL
        if review_id:
            text = self._items([review_id], None)[0][1]
        if not text:
            raise ApiError(400, "invalid_request", "Give a review id or a text.")
        key = (model, text)
        if key not in self.readings:
            resp = self.claude.create(model=model, max_tokens=4000, system=CLAUDE_SYSTEM,
                                      output_config={"effort": "low",
                                                     "format": {"type": "json_schema", "schema": CLAUDE_SCHEMA}},
                                      messages=[{"role": "user", "content": f"<review>{text}</review>"}])
            if resp.stop_reason in ("refusal", "max_tokens"):
                raise ApiError(502, "no_answer", f"Claude stopped early ({resp.stop_reason}). Try again.")
            cost = self.spend.charge(resp, model) or 0.0
            with self._lock:
                self.spent_usd += cost
                self.readings[key] = {"reading": json.loads(text_of(resp)), "model": model, "cost_usd": cost,
                                      "input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}
            return {**self.readings[key], "reused": False, "spent_usd": self.spent_usd}
        return {**self.readings[key], "reused": True, "spent_usd": self.spent_usd}
