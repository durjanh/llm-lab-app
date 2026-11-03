"""Azure Speech: the only code that signs in to Azure.

The browser speaks and listens with Azure's Speech SDK, but never holds a key. It asks this
server for a token. The server signs in one of two ways:

- With a key (AZURE_SPEECH_KEY and AZURE_SPEECH_REGION): it swaps the key for a 10-minute token.
- Without a key (AZURE_SPEECH_RESOURCE_ID and AZURE_SPEECH_REGION): it gets a Microsoft Entra
  token with your Azure login (`az login` on your machine, or a managed identity on Azure) and
  passes it in the form Speech expects, "aad#<resource id>#<token>". The resource needs a custom
  domain, and your identity the "Cognitive Services Speech User" role on it.

Either token is reused for 8 minutes, and the page fetches a new one before its copy runs out.

AZURE_SPEECH_FALLBACK_RESOURCE_ID names a second resource for when the first refuses: typically a
free-tier (F0) resource first, whose monthly allowance and request rate are limited, and a paid
one to fall back to. The page asks for the fallback's token only when the first one is refused.
"""
from __future__ import annotations

import threading
import time
import urllib.error
import urllib.request
from typing import Protocol

TOKEN_REUSE_S = 8 * 60
ENTRA_SCOPE = "https://cognitiveservices.azure.com/.default"


class SpeechTokens(Protocol):
    configured: bool
    region: str
    has_fallback: bool

    def token(self, fallback: bool = False) -> str: ...


class SpeechNotAvailable(RuntimeError):
    """Azure Speech is not set up, or Azure refused the request."""


class AzureSpeech:
    def __init__(self, key: str, region: str, resource_id: str = "", fallback_resource_id: str = "",
                 timeout_s: float = 10.0):
        self.key, self.region, self.timeout_s = key.strip(), region.strip().lower(), timeout_s
        self.resource_id, self.fallback_resource_id = resource_id.strip(), fallback_resource_id.strip()
        self._tokens: dict[bool, tuple[str, float]] = {}
        self._credential = None
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.region and (self.key or self.resource_id))

    @property
    def has_fallback(self) -> bool:
        return bool(self.configured and self.fallback_resource_id)

    def token(self, fallback: bool = False) -> str:
        if not self.configured:
            raise SpeechNotAvailable("Azure Speech is not set up. Add AZURE_SPEECH_REGION and either AZURE_SPEECH_KEY "
                                     "or AZURE_SPEECH_RESOURCE_ID to .env, and restart the backend.")
        if fallback and not self.has_fallback:
            raise SpeechNotAvailable("No fallback Speech resource is set up (AZURE_SPEECH_FALLBACK_RESOURCE_ID).")
        with self._lock:
            cached = self._tokens.get(fallback)
            if cached and time.monotonic() - cached[1] < TOKEN_REUSE_S:
                return cached[0]
            if fallback:
                token = self._entra_token(self.fallback_resource_id)
            else:
                token = self._key_token() if self.key else self._entra_token(self.resource_id)
            self._tokens[fallback] = (token, time.monotonic())
            return token

    def _entra_token(self, resource_id: str) -> str:
        try:
            from azure.identity import DefaultAzureCredential
        except ImportError as exc:
            raise SpeechNotAvailable("Signing in without a key needs azure-identity: "
                                     "pip install -r backend/requirements.txt") from exc
        if self._credential is None:
            self._credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
        try:
            entra = self._credential.get_token(ENTRA_SCOPE).token
        except Exception as exc:  # no login, an expired login, or no access
            raise SpeechNotAvailable(f"Could not sign in to Azure for Speech. Run `az login` and try again. ({exc})") from exc
        return f"aad#{resource_id}#{entra}"

    def _key_token(self) -> str:
        request = urllib.request.Request(
            f"https://{self.region}.api.cognitive.microsoft.com/sts/v1.0/issueToken", data=b"", method="POST",
            headers={"Ocp-Apim-Subscription-Key": self.key, "Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                return response.read().decode()
        except urllib.error.HTTPError as exc:
            hint = " Check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION." if exc.code in (401, 403, 404) else ""
            raise SpeechNotAvailable(f"Azure refused the token request (HTTP {exc.code}).{hint}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise SpeechNotAvailable(f"Could not reach Azure Speech in region {self.region}: {exc}") from exc
