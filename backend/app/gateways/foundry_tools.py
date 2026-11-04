"""Foundry Tools and models over REST, signed in with your Azure login: the AI-103 labs' one gateway.

Two AI Services resources. The lab's own (UK South) runs Content Safety, PII detection, Translator, Content
Understanding and gpt-5.4-mini. The media resource (Sweden Central) runs gpt-image-2, and groundedness detection,
which in UK South answers "grounded" for everything instead of refusing. Resource Manager calls are read-only:
deployments, quotas, metrics, content filters and role assignments, for the operations lab.
"""
from __future__ import annotations

import base64
import time
from typing import Any

import httpx

from ..core.errors import ApiError

SAFETY_API = "2024-09-01"
GROUNDEDNESS_API = "2024-09-15-preview"
LANGUAGE_API = "2024-11-01"
CU_API = "2025-11-01"
CU_PREVIEW_API = "2026-06-01-preview"  # agentic mode
COGNITIVE = "https://cognitiveservices.azure.com/.default"
ARM = "https://management.azure.com/.default"


class FoundryTools:
    def __init__(self, endpoint: str, media_endpoint: str = "", resource_id: str = "", media_resource_id: str = ""):
        self.endpoint = endpoint.rstrip("/")
        self.media_endpoint = media_endpoint.rstrip("/")
        self.resource_id, self.media_resource_id = resource_id, media_resource_id
        self._tokens: dict[str, tuple[str, float]] = {}
        self._credential: Any = None

    # ----- plumbing -----
    def _auth(self, scope: str = COGNITIVE) -> dict[str, str]:
        token = self._tokens.get(scope)
        if token is None or token[1] < time.time() + 120:
            from azure.identity import DefaultAzureCredential

            self._credential = self._credential or DefaultAzureCredential()
            t = self._credential.get_token(scope)
            token = self._tokens[scope] = (t.token, t.expires_on)
        return {"Authorization": f"Bearer {token[0]}"}

    def _send(self, what: str, method: str, url: str, *, scope: str = COGNITIVE, timeout: float = 90,
              **kwargs: Any) -> httpx.Response:
        try:
            r = httpx.request(method, url, headers={**self._auth(scope), **kwargs.pop("headers", {})}, timeout=timeout,
                              **kwargs)
        except httpx.HTTPError as exc:
            raise ApiError(502, "azure_unreachable", f"{what}: could not reach Azure ({exc}).") from exc
        if r.status_code in (401, 403):
            raise ApiError(502, "azure_auth", f"{what} refused the sign-in ({r.status_code}). Run az login, and check "
                                              "your account has a data role on the resource.")
        if r.status_code == 429:
            wait = r.headers.get("retry-after", "")
            raise ApiError(429, "rate_limited", f"{what} is rate limiting this deployment"
                                                + (f": retry after {wait} s." if wait else ". Wait a moment and try again."))
        if r.status_code >= 400:
            raise ApiError(502, "azure_error", f"{what} returned {r.status_code}: {_message(r)}")
        return r

    def _json(self, what: str, method: str, url: str, **kwargs: Any) -> Any:
        return self._send(what, method, url, **kwargs).json()

    def _media(self) -> str:
        if not self.media_endpoint:
            raise ApiError(503, "not_configured", "Set AZURE_MEDIA_ENDPOINT in .env (a resource in Sweden Central) and "
                                                  "restart the backend.")
        return self.media_endpoint

    # ----- Content Safety -----
    def analyze_text(self, text: str, blocklists: list[str] | None = None) -> dict:
        body: dict[str, Any] = {"text": text, "outputType": "EightSeverityLevels"}
        if blocklists:
            body.update({"blocklistNames": blocklists, "haltOnBlocklistHit": False})
        return self._json("Content Safety", "POST", f"{self.endpoint}/contentsafety/text:analyze",
                          params={"api-version": SAFETY_API}, json=body)

    def analyze_image(self, image: bytes) -> dict:
        return self._json("Content Safety", "POST", f"{self.endpoint}/contentsafety/image:analyze",
                          params={"api-version": SAFETY_API},
                          json={"image": {"content": base64.b64encode(image).decode()}})

    def shield(self, user_prompt: str, documents: list[str]) -> dict:
        return self._json("Prompt Shields", "POST", f"{self.endpoint}/contentsafety/text:shieldPrompt",
                          params={"api-version": SAFETY_API}, json={"userPrompt": user_prompt, "documents": documents})

    def protected_material(self, text: str) -> dict:
        return self._json("Protected material detection", "POST", f"{self.endpoint}/contentsafety/text:detectProtectedMaterial",
                          params={"api-version": SAFETY_API}, json={"text": text})

    def groundedness(self, text: str, sources: list[str], query: str = "") -> dict:
        body: dict[str, Any] = {"domain": "Generic", "task": "QnA" if query else "Summarization", "text": text,
                                "groundingSources": sources, "reasoning": False}
        if query:
            body["qna"] = {"query": query}
        return self._json("Groundedness detection", "POST", f"{self._media()}/contentsafety/text:detectGroundedness",
                          params={"api-version": GROUNDEDNESS_API}, json=body)

    def put_blocklist(self, name: str, description: str, items: list[str]) -> None:
        base = f"{self.endpoint}/contentsafety/text/blocklists/{name}"
        self._send("Content Safety blocklist", "PATCH", base, params={"api-version": SAFETY_API},
                   json={"description": description}, headers={"Content-Type": "application/merge-patch+json"})
        self._send("Content Safety blocklist", "POST", f"{base}:addOrUpdateBlocklistItems", params={"api-version": SAFETY_API},
                   json={"blocklistItems": [{"text": t, "description": "lab"} for t in items]})

    # ----- Azure Language: PII -----
    def pii(self, text: str, language: str = "en") -> dict:
        r = self._json("Azure Language", "POST", f"{self.endpoint}/language/:analyze-text", params={"api-version": LANGUAGE_API},
                       json={"kind": "PiiEntityRecognition",
                             "analysisInput": {"documents": [{"id": "1", "language": language, "text": text}]}})
        return r["results"]["documents"][0]

    def language(self, kind: str, documents: list[dict], parameters: dict | None = None) -> list[dict]:
        """Any Azure Language text task (key phrases, entities, language detection) on up to ten documents."""
        body: dict[str, Any] = {"kind": kind, "analysisInput": {"documents": documents}}
        if parameters:
            body["parameters"] = parameters
        r = self._json("Azure Language", "POST", f"{self.endpoint}/language/:analyze-text", params={"api-version": LANGUAGE_API},
                       json=body)
        return r["results"]["documents"]

    def embed(self, texts: list[str], model: str = "text-embedding-3-small") -> tuple[list[list[float]], int]:
        """Embeddings for a batch of texts, and the tokens they cost."""
        r = self._json(f"Azure OpenAI ({model})", "POST", f"{self.endpoint}/openai/v1/embeddings",
                       json={"model": model, "input": texts})
        return [d["embedding"] for d in sorted(r["data"], key=lambda d: d["index"])], r["usage"]["total_tokens"]

    # ----- Translator -----
    def translator(self, route: str, body: list[dict], **params: Any) -> list[dict]:
        return self._json("Translator", "POST", f"{self.endpoint}/translator/text/v3.0/{route}",
                          params={"api-version": "3.0", **params}, json=body)

    # ----- Content Understanding -----
    def cu_analyze(self, analyzer: str, data: bytes, mime: str, timeout_s: float = 240, api_version: str = CU_API) -> dict:
        """Sends a file, waits for the analysis and returns its result, with the service's usage report.
        Long media can take a minute or more."""
        r = self._send("Content Understanding", "POST", f"{self.endpoint}/contentunderstanding/analyzers/{analyzer}:analyzeBinary",
                       params={"api-version": api_version}, content=data, headers={"Content-Type": mime})
        return self._poll(r.headers["Operation-Location"], timeout_s)

    def _poll(self, url: str, timeout_s: float) -> dict:
        end = time.time() + timeout_s
        while time.time() < end:
            j = self._json("Content Understanding", "GET", url)
            if j.get("status") == "Succeeded":
                return {**j.get("result", j), "usage": j.get("usage") or {}}
            if j.get("status") in ("Failed", "Canceled"):
                raise ApiError(502, "cu_failed", f"Content Understanding: {_message_json(j)}")
            time.sleep(1.5)
        raise ApiError(504, "timeout", "Content Understanding took too long. Try a smaller file.")

    def cu_put_analyzer(self, analyzer: str, definition: dict, api_version: str = CU_API) -> dict:
        r = self._send("Content Understanding", "PUT", f"{self.endpoint}/contentunderstanding/analyzers/{analyzer}",
                       params={"api-version": api_version, "allowReplace": "true"}, json=definition)
        location = r.headers.get("Operation-Location")
        return self._poll(location, 120) if location else r.json()

    def cu_get_analyzer(self, analyzer: str) -> dict:
        return self._json("Content Understanding", "GET", f"{self.endpoint}/contentunderstanding/analyzers/{analyzer}",
                          params={"api-version": CU_API})

    # ----- Foundry models -----
    def chat(self, model: str, messages: list[dict], **params: Any) -> dict:
        """Chat completions on the v1 API, images included as data URLs."""
        return self._json(f"Azure OpenAI ({model})", "POST", f"{self.endpoint}/openai/v1/chat/completions", timeout=180,
                          json={"model": model, "messages": messages, **params})

    def generate_image(self, prompt: str, **params: Any) -> dict:
        return self._json("gpt-image-2", "POST", f"{self._media()}/openai/v1/images/generations", timeout=240,
                          json={"model": "gpt-image-2", "prompt": prompt, **params})

    def edit_image(self, prompt: str, images: list[bytes], mask: bytes | None = None, **params: Any) -> dict:
        """Reference images, and optionally a mask whose transparent pixels mark what may change (inpainting)."""
        files: list[tuple[str, tuple[str, bytes, str]]] = [("image[]", (f"image{i}.png", b, "image/png"))
                                                           for i, b in enumerate(images)]
        if mask is not None:
            files.append(("mask", ("mask.png", mask, "image/png")))
        data = {"model": "gpt-image-2", "prompt": prompt, **{k: str(v) for k, v in params.items()}}
        return self._json("gpt-image-2", "POST", f"{self._media()}/openai/v1/images/edits", timeout=240,
                          data=data, files=files)

    # ----- Resource Manager (read only) -----
    def arm(self, path: str, api_version: str, **params: Any) -> dict:
        return self._json("Azure Resource Manager", "GET", f"https://management.azure.com{path}", scope=ARM,
                          params={"api-version": api_version, **params})


def _message(r: httpx.Response) -> str:
    try:
        return _message_json(r.json())
    except ValueError:
        return r.text[:300]


def _message_json(j: dict) -> str:
    e = j.get("error") or {}
    inner = e.get("innererror") or {}
    return str(inner.get("message") or e.get("message") or j)[:400]
