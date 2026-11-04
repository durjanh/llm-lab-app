"""Translation, domain text analysis, and reasoning over audio. Speech itself runs in the browser with Azure Speech."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..schemas import AudioQuestion, DictionaryLookup, GuardText, TranslateLlm, TranslateText, Transliterate
from ..services.translate import TranslateService
from .deps import require_budget, require_lab_page, translate

router = APIRouter(dependencies=[Depends(require_lab_page)])
PAID = [Depends(require_budget)]


@router.get("/translate/info")
def info(service: TranslateService = Depends(translate)) -> dict[str, Any]:
    return service.info()


@router.post("/translate/text", dependencies=PAID)
def text(body: TranslateText, service: TranslateService = Depends(translate)) -> dict[str, Any]:
    return service.translate(body.text, body.targets, body.glossary, body.profanity)


@router.post("/translate/llm", dependencies=PAID)
def llm(body: TranslateLlm, service: TranslateService = Depends(translate)) -> dict[str, Any]:
    return service.translate_llm(body.text, body.target, body.tone, body.glossary)


@router.post("/translate/transliterate", dependencies=PAID)
def transliterate(body: Transliterate, service: TranslateService = Depends(translate)) -> dict[str, Any]:
    return service.transliterate(body.text, body.language, body.from_script, body.to_script)


@router.post("/translate/dictionary", dependencies=PAID)
def dictionary(body: DictionaryLookup, service: TranslateService = Depends(translate)) -> dict[str, Any]:
    return service.dictionary(body.word, body.source, body.target)


@router.post("/translate/complaint", dependencies=PAID)
def complaint(body: GuardText, service: TranslateService = Depends(translate)) -> dict[str, Any]:
    """A complaint in any language as a complaints-log entry, against a JSON schema."""
    return service.complaint(body.text)


@router.post("/translate/audio", dependencies=PAID)
def audio(body: AudioQuestion, service: TranslateService = Depends(translate)) -> dict[str, Any]:
    return service.audio(body.question)
