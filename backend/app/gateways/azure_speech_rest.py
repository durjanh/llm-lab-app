"""Azure Speech over REST, server side: fast transcription with language identification, and text to speech.

Both calls go to the lab's AI Services account (AZURE_LANGUAGE_ENDPOINT, its custom domain), signed in with Entra
(`az login` here, a managed identity on Azure): no keys. The browser's own speech (the tutor, dictation) still uses
the token route in azure_speech.py; this gateway is for work done on the server, such as translating a video.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Protocol

ENTRA_SCOPE = "https://cognitiveservices.azure.com/.default"
TRANSCRIBE_API = "2024-11-15"  # fast transcription


class SpeechRest(Protocol):
    def transcribe(self, wav: bytes, locales: list[str]) -> dict[str, Any]: ...
    def synthesize(self, ssml: str) -> bytes: ...


class SpeechRestError(RuntimeError):
    """Azure refused or could not be reached; the message is fit for the page."""


class AzureSpeechRest:
    def __init__(self, endpoint: str, credential: Any = None, timeout_s: float = 180.0):
        self.endpoint, self.timeout_s = endpoint.rstrip("/"), timeout_s
        self._credential = credential
        self._token: tuple[str, float] | None = None
        self._lock = threading.Lock()

    def _bearer(self) -> str:
        with self._lock:
            if self._token and time.monotonic() - self._token[1] < 30 * 60:
                return self._token[0]
            if self._credential is None:
                from azure.identity import DefaultAzureCredential
                self._credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
            try:
                token = self._credential.get_token(ENTRA_SCOPE).token
            except Exception as exc:  # no login, an expired one, or no access
                raise SpeechRestError(f"Could not sign in to Azure for Speech. Run `az login` and try again. ({exc})") from exc
            self._token = (token, time.monotonic())
            return token

    def _post(self, path: str, data: bytes, content_type: str, extra: dict[str, str] | None = None) -> bytes:
        req = urllib.request.Request(f"{self.endpoint}{path}", data=data, method="POST",
                                     headers={"Authorization": f"Bearer {self._bearer()}", "Content-Type": content_type,
                                              "User-Agent": "llm-lab", **(extra or {})})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:300].decode(errors="replace")
            hint = " Check that your identity has the Cognitive Services Speech User role." if exc.code in (401, 403) else ""
            raise SpeechRestError(f"Azure Speech refused the request (HTTP {exc.code}).{hint} {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise SpeechRestError(f"Could not reach Azure Speech: {exc}") from exc

    def transcribe(self, wav: bytes, locales: list[str]) -> dict[str, Any]:
        """Fast transcription. With several locales, Azure identifies which one is spoken, phrase by phrase."""
        boundary = uuid.uuid4().hex
        definition = json.dumps({"locales": locales, "profanityFilterMode": "None"})
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"definition\"\r\n"
                f"Content-Type: application/json\r\n\r\n{definition}\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"audio.wav\"\r\n"
                f"Content-Type: audio/wav\r\n\r\n").encode() + wav + f"\r\n--{boundary}--\r\n".encode()
        out = self._post(f"/speechtotext/transcriptions:transcribe?api-version={TRANSCRIBE_API}", body,
                         f"multipart/form-data; boundary={boundary}")
        return json.loads(out)

    def synthesize(self, ssml: str) -> bytes:
        """Neural text to speech: a 16 kHz mono WAV."""
        return self._post("/tts/cognitiveservices/v1", ssml.encode(), "application/ssml+xml",
                          {"X-Microsoft-OutputFormat": "riff-16khz-16bit-mono-pcm"})
