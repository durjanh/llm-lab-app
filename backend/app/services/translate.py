"""Translation, text analysis for domain tasks, and the server side of the speech lab.

Azure Translator translates to several languages in one call, detects the source language, keeps glossary terms
through dynamic-dictionary markup, transliterates between scripts and looks words up in its dictionary. A language
model translates too, with control over tone and terms, at a different price and speed. Domain tasks (a complaints
log entry, tone and vulnerability signals) come back as JSON against a schema. Speech runs in the browser with
Azure Speech; the backend reasons over a recording through Content Understanding's audio analyzer.
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

from ..core.errors import ApiError
from ..gateways.foundry_tools import FoundryTools
from ..shared import PRICES, TOOL_PRICES
from .spend import SpendTracker
from .understanding import UnderstandingService

MODEL = "gpt-5.4-mini"
GLOSSARY = {  # an insurer's approved terms, by target language
    "escape of water": {"es": "daños por agua", "fr": "dégât des eaux", "de": "Leitungswasserschaden", "pl": "zalanie", "cy": "dŵr yn dianc"},
    "excess": {"es": "franquicia", "fr": "franchise", "de": "Selbstbeteiligung", "pl": "udział własny", "cy": "tâl-dros-ben"},
    "policyholder": {"es": "titular de la póliza", "fr": "assuré", "de": "Versicherungsnehmer", "pl": "ubezpieczający", "cy": "deiliad y polisi"},
}
SAMPLES = [
    {"label": "Letter to a customer (English)", "text": "Dear Ms Nair, your escape of water claim has been approved. The excess "
     "of £350 will be deducted from the settlement. As the policyholder, you can appeal within 8 weeks."},
    {"label": "Complaint (Spanish)", "text": "Llevo tres semanas esperando una respuesta. El techo de la cocina sigue roto y "
     "tengo dos niños pequeños en casa. Nadie me devuelve las llamadas. Esto es inaceptable."},
    {"label": "Message (Polish)", "text": "Dzień dobry, sąsiad z góry zalał moją kuchnię. Czy ubezpieczenie pokryje malowanie sufitu?"},
    {"label": "Message (Welsh)", "text": "Bore da, mae dŵr wedi dod drwy nenfwd y gegin. Beth ddylwn i ei wneud nesaf?"},
]
TARGETS = ["es", "fr", "de", "pl", "cy", "ar", "ur", "zh-Hans"]
COMPLAINT_SCHEMA = {"type": "object", "additionalProperties": False,
                    "required": ["summary_english", "language", "category", "tone", "vulnerability_signals",
                                 "redress_requested", "deadline_days", "entities"],
                    "properties": {
                        "summary_english": {"type": "string", "description": "two sentences for the complaints log"},
                        "language": {"type": "string"},
                        "category": {"type": "string", "enum": ["delay", "claim decision", "staff conduct", "communication", "price", "other"]},
                        "tone": {"type": "string", "enum": ["calm", "frustrated", "angry", "distressed"]},
                        "vulnerability_signals": {"type": "array", "items": {"type": "string"},
                                                  "description": "signs the customer may need extra care, such as young children or illness"},
                        "redress_requested": {"type": "string"},
                        "deadline_days": {"type": "integer", "description": "UK FCA rule: a final response within 56 days (8 weeks)"},
                        "entities": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                                "required": ["text", "kind"],
                                                                "properties": {"text": {"type": "string"},
                                                                               "kind": {"type": "string", "enum": ["person", "place", "product", "amount", "date", "other"]}}}}}}


def with_glossary(text: str, target: str) -> tuple[str, list[str]]:
    """Wraps each glossary term in Translator's dynamic dictionary markup for the target language."""
    used = []
    for term, by_lang in GLOSSARY.items():
        if target in by_lang and re.search(rf"\b{re.escape(term)}\b", text, re.I):
            text = re.sub(rf"\b({re.escape(term)})\b",
                          lambda m: f'<mstrans:dictionary translation="{by_lang[target]}">{m.group(1)}</mstrans:dictionary>', text, flags=re.I)
            used.append(term)
    return text, used


class TranslateService:
    def __init__(self, tools: FoundryTools | None, spend: SpendTracker, understanding: UnderstandingService):
        self.tools, self.spend, self.understanding = tools, spend, understanding

    def _tools(self) -> FoundryTools:
        if self.tools is None:
            raise ApiError(503, "not_configured", "Set AZURE_LANGUAGE_ENDPOINT (your AI Services resource) in .env, run "
                                                  "az login, and restart the backend.")
        return self.tools

    def _charge_chars(self, n: int) -> float:
        return self.spend.charge_usd(n * TOOL_PRICES["translator_per_1m_chars"] / 1e6, "Translator")

    def _charge_model(self, r: dict) -> float:
        u = r.get("usage") or {}
        return self.spend.charge_usd((u.get("prompt_tokens", 0) * PRICES[MODEL]["input"]
                                      + u.get("completion_tokens", 0) * PRICES[MODEL]["output"]) / 1e6, MODEL)

    def info(self) -> dict[str, Any]:
        return {"configured": self.tools is not None, "model": MODEL, "samples": SAMPLES, "targets": TARGETS,
                "glossary": GLOSSARY, "schema": COMPLAINT_SCHEMA, "price_per_m_chars": TOOL_PRICES["translator_per_1m_chars"]}

    def translate(self, text: str, targets: list[str], glossary: bool, profanity: str) -> dict[str, Any]:
        """One call per target when the glossary is on (its markup is per language), otherwise one call for all."""
        tools = self._tools()
        started = time.perf_counter()
        out: dict[str, Any] = {"translations": [], "detected": None, "glossary_used": []}
        chars = 0
        groups = [[t] for t in targets] if glossary else [targets]
        for group in groups:
            body_text, used = with_glossary(text, group[0]) if glossary else (text, [])
            out["glossary_used"] = sorted(set(out["glossary_used"]) | set(used))
            r = tools.translator("translate", [{"Text": body_text}], to=group, profanityAction=profanity,
                                 includeSentenceLength="true")[0]
            out["detected"] = out["detected"] or r.get("detectedLanguage")
            out["translations"] += [{"to": t["to"], "text": t["text"], "sentences": len(t.get("sentLen", {}).get("transSentLen", []))}
                                    for t in r["translations"]]
            chars += len(text) * len(group)  # billed per character, per target language
        return {**out, "chars_billed": chars, "ms": round((time.perf_counter() - started) * 1000),
                "cost_usd": round(self._charge_chars(chars), 6), "spent_usd": self.spend.spent_usd}

    def translate_llm(self, text: str, target: str, tone: str, glossary: bool) -> dict[str, Any]:
        terms = "; ".join(f"'{k}' must be '{v[target]}'" for k, v in GLOSSARY.items() if target in v) if glossary else ""
        prompt = (f"Translate the text into the language with code {target}. Tone: {tone}. Keep amounts, names and "
                  f"reference numbers exactly as they are. {('Use these terms: ' + terms + '.') if terms else ''} "
                  "Reply with the translation only.")
        started = time.perf_counter()
        r = self._tools().chat(MODEL, [{"role": "system", "content": prompt}, {"role": "user", "content": text}],
                               max_completion_tokens=800)
        return {"to": target, "text": r["choices"][0]["message"]["content"], "ms": round((time.perf_counter() - started) * 1000),
                "tokens": (r.get("usage") or {}).get("total_tokens"), "cost_usd": round(self._charge_model(r), 6),
                "spent_usd": self.spend.spent_usd}

    def transliterate(self, text: str, language: str, from_script: str, to_script: str) -> dict[str, Any]:
        r = self._tools().translator("transliterate", [{"Text": text}], language=language, fromScript=from_script, toScript=to_script)
        return {"text": r[0]["text"], "script": r[0]["script"], "cost_usd": round(self._charge_chars(len(text)), 6)}

    def dictionary(self, word: str, source: str, target: str) -> dict[str, Any]:
        r = self._tools().translator("dictionary/lookup", [{"Text": word}], **{"from": source, "to": target})
        return {"entries": [{"target": t["displayTarget"], "pos": t["posTag"], "confidence": t["confidence"],
                             "back": [b["displayText"] for b in t["backTranslations"][:4]]} for t in r[0]["translations"][:6]],
                "cost_usd": round(self._charge_chars(len(word)), 6)}

    def complaint(self, text: str) -> dict[str, Any]:
        """A complaint in any language as a complaints-log entry, against a JSON schema."""
        system = ("You log customer complaints for a UK home insurer. Read the message in any language and fill in the "
                  "schema. The summary is in English and neutral. Vulnerability signals are only what the customer says, "
                  "never guesses. deadline_days is the FCA's final-response deadline in days.")
        started = time.perf_counter()
        r = self._tools().chat(MODEL, [{"role": "system", "content": system}, {"role": "user", "content": text}],
                               max_completion_tokens=700,
                               response_format={"type": "json_schema", "json_schema": {"name": "complaint", "schema": COMPLAINT_SCHEMA, "strict": True}})
        return {"entry": json.loads(r["choices"][0]["message"]["content"]), "ms": round((time.perf_counter() - started) * 1000),
                "cost_usd": round(self._charge_model(r), 6), "spent_usd": self.spend.spent_usd}

    def audio(self, question: str) -> dict[str, Any]:
        """The narration through Content Understanding (transcript, speakers, summary), then a question over it."""
        cu = self.understanding.analyze("audio", "prebuilt-audioSearch")
        transcript = " ".join(p["text"] for p in cu["transcript"])
        summary = next((f["value"] for f in cu["fields"] if f["name"] == "Summary"), "")
        r = self._tools().chat(MODEL, [{"role": "system", "content": "Answer from the transcript only, in one or two sentences."},
                                       {"role": "user", "content": f"Transcript:\n{transcript}\n\nQuestion: {question}"}],
                               max_completion_tokens=300)
        return {"transcript": cu["transcript"], "summary": summary, "answer": r["choices"][0]["message"]["content"],
                "seconds": cu["seconds"], "cost_usd": round(cu["cost_usd"] + self._charge_model(r), 6),
                "spent_usd": self.spend.spent_usd}
