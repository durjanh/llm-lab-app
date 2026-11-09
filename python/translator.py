"""Live translation for MedAssist and Aftercare: phone calls in the caller's language, texts in the patient's.

The agents themselves speak many languages, so a call's conversation happens in the caller's language: the line
listens and speaks in it, and the agent is told to reply in it. What the agents do not do is the staff's copy: Azure
Translator turns each line into English for the record, and turns the line's own fixed wording (the greeting, the 999
message) and the texts' fixed wording into the caller's language, so what is said about emergencies is a translation
of reviewed English, not something a model made up. The English always stays in the record beside the translation.

Translator is reached through the lab's AI Services account (AZURE_LANGUAGE_ENDPOINT), signed in with Entra: no keys.
The voices below were checked against the lab's Speech resource; each language has a female neural voice.
"""
from __future__ import annotations

import json
import threading
import urllib.parse
import urllib.request
from typing import Any

# code: (name, speech locale, voice). The UK's most spoken languages after English, among others.
LANGUAGES: dict[str, tuple[str, str, str]] = {
    "en": ("English", "en-GB", "en-GB-SoniaNeural"),
    "es": ("Spanish", "es-ES", "es-ES-ElviraNeural"),
    "pl": ("Polish", "pl-PL", "pl-PL-AgnieszkaNeural"),
    "ur": ("Urdu", "ur-PK", "ur-PK-UzmaNeural"),
    "pa": ("Punjabi", "pa-IN", "pa-IN-VaaniNeural"),
    "ar": ("Arabic", "ar-SA", "ar-SA-ZariyahNeural"),
    "ro": ("Romanian", "ro-RO", "ro-RO-AlinaNeural"),
    "pt": ("Portuguese", "pt-PT", "pt-PT-RaquelNeural"),
    "bn": ("Bengali", "bn-IN", "bn-IN-TanishaaNeural"),
    "gu": ("Gujarati", "gu-IN", "gu-IN-DhwaniNeural"),
    "hi": ("Hindi", "hi-IN", "hi-IN-AnanyaNeural"),
    "ta": ("Tamil", "ta-IN", "ta-IN-PallaviNeural"),
    "fr": ("French", "fr-FR", "fr-FR-DeniseNeural"),
    "it": ("Italian", "it-IT", "it-IT-ElsaNeural"),
    "zh-Hans": ("Chinese (Mandarin)", "zh-CN", "zh-CN-XiaoxiaoNeural"),
    "tr": ("Turkish", "tr-TR", "tr-TR-EmelNeural"),
    "so": ("Somali", "so-SO", "so-SO-UbaxNeural"),
    "lt": ("Lithuanian", "lt-LT", "lt-LT-OnaNeural"),
}


def name_of(code: str) -> str:
    return LANGUAGES.get(code, LANGUAGES["en"])[0]


class Translator:
    """Azure Translator through an AI Services account. Fixed wording is translated once and remembered."""

    def __init__(self, endpoint: str, credential: Any = None):
        self.endpoint = endpoint.rstrip("/")
        self._credential = credential
        self._cache: dict[tuple[str, str, str], str] = {}
        self._lock = threading.Lock()

    def _token(self) -> str:
        if self._credential is None:
            from azure.identity import DefaultAzureCredential
            self._credential = DefaultAzureCredential()
        return self._credential.get_token("https://cognitiveservices.azure.com/.default").token

    def translate(self, text: str, to: str, source: str | None = None) -> str:
        """The text in language `to`. Raises if Translator cannot be reached: callers keep the original then."""
        if not text.strip() or to == (source or ""):
            return text
        key = (text, to, source or "")
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        query = urllib.parse.urlencode({"api-version": "3.0", "to": to, **({"from": source} if source else {})})
        req = urllib.request.Request(f"{self.endpoint}/translator/text/v3.0/translate?{query}",
                                     data=json.dumps([{"Text": text}]).encode(), method="POST",
                                     headers={"Authorization": f"Bearer {self._token()}",
                                              "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            out = json.load(resp)[0]["translations"][0]["text"]
        with self._lock:
            self._cache[key] = out
        return out


def to_language(translator: Translator | None, text: str, language: str) -> str:
    """Fixed English wording in the caller's language, or the English if there is no translator or it fails."""
    if translator is None or language == "en":
        return text
    try:
        return translator.translate(text, language, "en")
    except Exception:  # noqa: BLE001  (the network, Azure): English is better than silence
        return text


def to_english(translator: Translator | None, text: str, language: str) -> str:
    """The staff's English copy of a line said in another language; '' when it is English or cannot be translated."""
    if translator is None or language == "en" or not text.strip():
        return ""
    try:
        return translator.translate(text, "en", language)
    except Exception:  # noqa: BLE001
        return ""
