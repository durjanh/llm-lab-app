"""Azure Language in Foundry Tools over its REST API, signed in with your Azure login.

Only the four prebuilt text features the review dashboard uses: language detection, sentiment analysis with
opinion mining, key phrase extraction and named entity recognition. Each feature takes a limited number of
documents per request, so a longer list is sent in several requests at once.
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Protocol

import httpx

from ..core.errors import ApiError

API_VERSION = "2024-11-01"
# Documents per request, from Microsoft's service limits. More in one request is a 400.
LIMITS = {"LanguageDetection": 1000, "SentimentAnalysis": 10, "KeyPhraseExtraction": 10, "EntityRecognition": 5}


class TextAnalyzer(Protocol):
    def analyze(self, kind: str, documents: list[dict], parameters: dict | None = None) -> dict: ...


class AzureLanguage:
    def __init__(self, endpoint: str):
        self.endpoint = endpoint.rstrip("/")
        self._token: tuple[str, float] | None = None
        self._credential: Any = None

    def _headers(self) -> dict[str, str]:
        if self._token is None or self._token[1] < time.time() + 120:
            from azure.identity import DefaultAzureCredential

            self._credential = self._credential or DefaultAzureCredential()
            t = self._credential.get_token("https://cognitiveservices.azure.com/.default")
            self._token = (t.token, t.expires_on)
        return {"Authorization": f"Bearer {self._token[0]}", "Content-Type": "application/json"}

    def _request(self, kind: str, documents: list[dict], parameters: dict | None) -> dict:
        body: dict[str, Any] = {"kind": kind, "analysisInput": {"documents": documents}}
        if parameters:
            body["parameters"] = parameters
        r = httpx.post(f"{self.endpoint}/language/:analyze-text", params={"api-version": API_VERSION},
                       headers=self._headers(), json=body, timeout=60)
        if r.status_code in (401, 403):
            raise ApiError(502, "azure_auth", "Azure Language refused the sign-in. Run az login, and check your account "
                                              "has the Cognitive Services Language Reader role on the resource.")
        if r.status_code == 429:
            raise ApiError(429, "rate_limited", "Azure Language is rate limiting this resource. Wait a minute and retry.")
        if r.status_code >= 400:
            raise ApiError(502, "azure_language", f"Azure Language returned {r.status_code}: {r.text[:300]}")
        return r.json()["results"]

    def analyze(self, kind: str, documents: list[dict], parameters: dict | None = None) -> dict:
        """Every document's result, in as many requests as the feature's limit needs. Returns documents, errors,
        the model version and the number of requests."""
        size = LIMITS[kind]
        batches = [documents[i:i + size] for i in range(0, len(documents), size)]
        with ThreadPoolExecutor(max_workers=min(8, len(batches) or 1)) as pool:
            results = list(pool.map(lambda b: self._request(kind, b, parameters), batches))
        return {"documents": [d for r in results for d in r["documents"]],
                "errors": [e for r in results for e in r["errors"]],
                "model_version": results[0]["modelVersion"] if results else "",
                "requests": len(batches)}
