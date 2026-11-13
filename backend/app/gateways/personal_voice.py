"""Azure personal voice: a synthetic copy of a person's own voice, made from their recorded consent and a short sample.

It is a limited-access feature: Microsoft must approve the use case (https://aka.ms/customneural) before the API
accepts a voice, and it runs only in some regions (not uksouth; swedencentral, westeurope, eastus and a few more). So it
uses its own Speech or AI Services resource, AZURE_PERSONAL_VOICE_RESOURCE_ID, signed in with your Azure login, the
same way as the tutor's other Speech calls. The steps, all REST under https://<resource>.cognitiveservices.azure.com:

1. a project of kind PersonalVoice (once);
2. a consent: the speaker reading Microsoft's consent statement, with their name and the company;
3. the personal voice: 5 to 90 seconds of clean speech, linked to that consent. It returns a speaker profile id,
   which SSML passes to a base model (PhoenixLatestNeural here: the one that sends mouth shapes for lip-sync).
"""
from __future__ import annotations

import threading
import time
from typing import Any, Protocol

API = "2026-01-01"
ENTRA_SCOPE = "https://cognitiveservices.azure.com/.default"
PROJECT = "llm-lab-tutor"
REGIONS = {"eastasia", "eastus", "eastus2", "southeastasia", "swedencentral", "westeurope", "westus2"}
STATUS_TTL_S = 300


class PersonalVoiceUnavailable(RuntimeError):
    """Personal voice is not set up, or Azure refused the request; the message says which and what to do."""


class PersonalVoices(Protocol):
    configured: bool
    region: str

    def status(self) -> dict[str, Any]: ...
    def token(self) -> str: ...
    def create_consent(self, consent_id: str, talent: str, company: str, locale: str, wav: bytes) -> dict[str, Any]: ...
    def create_voice(self, voice_id: str, consent_id: str, wav: bytes) -> dict[str, Any]: ...
    def consent(self, consent_id: str) -> dict[str, Any]: ...
    def voice(self, voice_id: str) -> dict[str, Any]: ...
    def delete(self, voice_id: str | None, consent_id: str | None) -> None: ...


def explain(code: int, body: str) -> str:
    """Azure's refusal, in words a person can act on."""
    if "UnsupportedApiRegion" in body:
        return ("This resource's region does not offer personal voice. Use one in swedencentral, westeurope, eastus, "
                "eastus2, westus2, eastasia or southeastasia.")
    if code == 403:
        return ("Azure refused: personal voice is a limited-access feature, so the resource needs Microsoft's approval "
                "(apply at https://aka.ms/customneural), and your login needs the Cognitive Services Speech "
                "Contributor role on it.")
    if code == 401:
        return "Azure did not accept the sign-in. Run `az login` and try again."
    return f"Azure answered HTTP {code}: {body[:300]}"


class AzurePersonalVoice:
    def __init__(self, resource_id: str, region: str, timeout_s: float = 60.0):
        self.resource_id, self.region, self.timeout_s = resource_id.strip(), region.strip().lower(), timeout_s
        self.name = self.resource_id.rstrip("/").split("/")[-1] if self.resource_id else ""
        self._credential: Any = None
        self._status: tuple[dict[str, Any], float] | None = None
        self._project_ready = False
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.name and self.region)

    def _url(self, path: str) -> str:
        return f"https://{self.name}.cognitiveservices.azure.com/customvoice/{path}?api-version={API}"

    def _entra(self) -> str:
        if not self.configured:
            raise PersonalVoiceUnavailable("Personal voice is not set up: add AZURE_PERSONAL_VOICE_RESOURCE_ID (and "
                                           "AZURE_PERSONAL_VOICE_REGION) to .env and restart the backend.")
        from azure.identity import DefaultAzureCredential

        with self._lock:
            if self._credential is None:
                self._credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
        try:
            return self._credential.get_token(ENTRA_SCOPE).token
        except Exception as exc:
            raise PersonalVoiceUnavailable(f"Could not sign in to Azure. Run `az login` and try again. ({exc})") from exc

    def token(self) -> str:
        """A token the browser's Speech SDK accepts for this resource: Entra, in Speech's aad# form."""
        return f"aad#{self.resource_id}#{self._entra()}"

    def _send(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        import httpx

        headers = {"Authorization": f"Bearer {self._entra()}"}
        try:
            r = httpx.request(method, self._url(path), headers=headers, timeout=self.timeout_s, **kwargs)
        except httpx.HTTPError as exc:
            raise PersonalVoiceUnavailable(f"Could not reach Azure personal voice: {exc}") from exc
        if r.status_code >= 400:
            raise PersonalVoiceUnavailable(explain(r.status_code, r.text))
        return r.json() if r.content else {}

    def status(self) -> dict[str, Any]:
        """Whether personal voice can be used: set up, in a region that offers it, and approved. Never raises."""
        if not self.configured:
            return {"configured": False, "ready": False,
                    "detail": "Not set up: add AZURE_PERSONAL_VOICE_RESOURCE_ID to .env (a resource in swedencentral "
                              "or another region that offers personal voice)."}
        if self._status and time.monotonic() - self._status[1] < STATUS_TTL_S:
            return self._status[0]
        out: dict[str, Any] = {"configured": True, "region": self.region, "resource": self.name}
        if self.region not in REGIONS:
            out.update(ready=False, detail=f"{self.region} does not offer personal voice.")
        else:
            try:
                self._send("GET", "basemodels")  # refused until the resource is approved for personal voice
                out.update(ready=True, detail="Ready.")
            except PersonalVoiceUnavailable as exc:
                out.update(ready=False, detail=str(exc))
        self._status = (out, time.monotonic())
        return out

    def _ensure_project(self) -> None:
        if self._project_ready:
            return
        projects = self._send("GET", "projects").get("value", [])
        if not any(p.get("id") == PROJECT for p in projects):
            self._send("PUT", f"projects/{PROJECT}",
                       json={"description": "LLM Lab tutor: people's own voices", "kind": "PersonalVoice"})
        self._project_ready = True

    def create_consent(self, consent_id: str, talent: str, company: str, locale: str, wav: bytes) -> dict[str, Any]:
        self._ensure_project()
        return self._send("POST", f"consents/{consent_id}",
                          data={"description": f"Consent from {talent}", "projectId": PROJECT,
                                "voiceTalentName": talent, "companyName": company, "locale": locale},
                          files={"audiodata": ("consent.wav", wav, "audio/wav")})

    def create_voice(self, voice_id: str, consent_id: str, wav: bytes) -> dict[str, Any]:
        return self._send("POST", f"personalvoices/{voice_id}",
                          data={"projectId": PROJECT, "consentId": consent_id},
                          files={"audiodata": ("sample.wav", wav, "audio/wav")})

    def consent(self, consent_id: str) -> dict[str, Any]:
        return self._send("GET", f"consents/{consent_id}")

    def voice(self, voice_id: str) -> dict[str, Any]:
        return self._send("GET", f"personalvoices/{voice_id}")

    def delete(self, voice_id: str | None, consent_id: str | None) -> None:
        """Deletes the voice, then its consent, at Azure. A missing one is not an error."""
        for path in ([f"personalvoices/{voice_id}"] if voice_id else []) + ([f"consents/{consent_id}"] if consent_id else []):
            try:
                self._send("DELETE", path)
            except PersonalVoiceUnavailable as exc:
                if "404" not in str(exc) and "NotFound" not in str(exc):
                    raise
