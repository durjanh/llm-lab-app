"""Real phone calls through Azure Communication Services Call Automation: ring a number, speak, listen, hang up.

Communication Services places the call and reports what happens (connected, the person said something, a prompt
finished, the call ended) as events to a callback URL. It speaks and listens through Azure AI Services, which it
reaches with its own managed identity (Cognitive Services User on that resource), so no keys here either. This
module only talks to the SDK; services/aftercare_phone.py decides what to say.
"""
from __future__ import annotations

import re
from typing import Any, Protocol

from ..shared import translator

# language code -> (speech locale, voice): every language in python/translator.py, voices checked against Azure
VOICES = {code: (locale, voice) for code, (_, locale, voice) in translator.LANGUAGES.items()}
# How the voice is delivered, by the person's age: rate, volume and pitch for SSML's <prosody>, and the pause
# between sentences. Older people often find a slower, calmer delivery with pauses easier to follow on the phone.
PACES = {"normal": None,
         "slower": {"rate": "-10%", "volume": "medium", "pitch": "default", "pause": "350ms"},
         "slowest": {"rate": "-20%", "volume": "soft", "pitch": "-3%", "pause": "600ms"}}


def pace_for_age(age: int) -> str:
    return "slowest" if age >= 80 else "slower" if age >= 65 else "normal"


def ssml(text: str, language: str, pace: str) -> str:
    """The text as SSML in the language's voice, at the pace given, with a pause after each sentence."""
    from xml.sax.saxutils import escape
    locale, voice = VOICES.get(language, VOICES["en"])
    p = PACES[pace]
    sentences = [escape(s) for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]
    body = f'<break time="{p["pause"]}"/>'.join(sentences)
    return (f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{locale}">'
            f'<voice name="{voice}"><prosody rate="{p["rate"]}" volume="{p["volume"]}" pitch="{p["pitch"]}">'
            f'{body}</prosody></voice></speak>')


class PhoneLine(Protocol):
    """What the Aftercare phone service needs from a phone line. Tests pass a fake."""

    def call(self, to: str, callback_url: str) -> str: ...
    def answer(self, incoming_call_context: str, callback_url: str) -> str: ...
    def say_and_listen(self, connection_id: str, to: str, text: str, language: str, context: str,
                       pace: str = "normal") -> None: ...
    def say(self, connection_id: str, text: str, language: str, context: str, pace: str = "normal") -> None: ...
    def hang_up(self, connection_id: str) -> None: ...


class CallAutomation:
    """The real line. Signed in with your Azure login; the caller ID is a number you bought in the resource."""

    def __init__(self, endpoint: str, caller_id: str, speech_endpoint: str):
        self.endpoint, self.caller_id, self.speech_endpoint = endpoint, caller_id, speech_endpoint
        self._client: Any = None

    @property
    def client(self) -> Any:
        if self._client is None:
            from azure.communication.callautomation import CallAutomationClient
            from azure.identity import DefaultAzureCredential
            self._client = CallAutomationClient(self.endpoint, DefaultAzureCredential())
        return self._client

    def call(self, to: str, callback_url: str) -> str:
        from azure.communication.callautomation import PhoneNumberIdentifier
        result = self.client.create_call(PhoneNumberIdentifier(to), callback_url,
                                         source_caller_id_number=PhoneNumberIdentifier(self.caller_id),
                                         cognitive_services_endpoint=self.speech_endpoint)
        return result.call_connection_id

    def answer(self, incoming_call_context: str, callback_url: str) -> str:
        """Answers a call someone made to the lab's number, from the context Event Grid delivered with it."""
        result = self.client.answer_call(incoming_call_context, callback_url,
                                         cognitive_services_endpoint=self.speech_endpoint)
        return result.call_connection_id

    def _prompt(self, text: str, language: str, pace: str = "normal") -> Any:
        from azure.communication.callautomation import SsmlSource, TextSource
        if PACES.get(pace):
            return SsmlSource(ssml_text=ssml(text, language, pace))
        locale, voice = VOICES.get(language, VOICES["en"])
        return TextSource(text=text, voice_name=voice, source_locale=locale)

    def say_and_listen(self, connection_id: str, to: str, text: str, language: str, context: str,
                       pace: str = "normal") -> None:
        """Speaks the text, then listens until the person has said something and paused."""
        from azure.communication.callautomation import PhoneNumberIdentifier, RecognizeInputType
        self.client.get_call_connection(connection_id).start_recognizing_media(
            RecognizeInputType.SPEECH, PhoneNumberIdentifier(to), play_prompt=self._prompt(text, language, pace),
            speech_language=VOICES.get(language, VOICES["en"])[0], initial_silence_timeout=10, end_silence_timeout=2,
            interrupt_prompt=True, operation_context=context)

    def say(self, connection_id: str, text: str, language: str, context: str, pace: str = "normal") -> None:
        self.client.get_call_connection(connection_id).play_media_to_all(self._prompt(text, language, pace),
                                                                         operation_context=context)

    def hang_up(self, connection_id: str) -> None:
        self.client.get_call_connection(connection_id).hang_up(is_for_everyone=True)
