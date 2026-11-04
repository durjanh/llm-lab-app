"""Azure AI Search over its REST API, signed in with your Azure login (the service has keys switched off).

Only what the case-handling lab needs: create an index with a vector field, upload documents, and run
a hybrid query (keywords and vectors together, merged by reciprocal rank fusion), optionally reranked by
the semantic ranker.
"""
from __future__ import annotations

import time
from typing import Any

import httpx

from ..core.errors import ApiError

API_VERSION = "2024-07-01"


class AzureSearch:
    def __init__(self, endpoint: str):
        self.endpoint = endpoint.rstrip("/")
        self._token: tuple[str, float] | None = None
        self._credential: Any = None

    def _headers(self) -> dict[str, str]:
        if self._token is None or self._token[1] < time.time() + 120:
            from azure.identity import DefaultAzureCredential

            self._credential = self._credential or DefaultAzureCredential()
            t = self._credential.get_token("https://search.azure.com/.default")
            self._token = (t.token, t.expires_on)
        return {"Authorization": f"Bearer {self._token[0]}", "Content-Type": "application/json"}

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        r = httpx.request(method, f"{self.endpoint}{path}", params={"api-version": API_VERSION},
                          headers=self._headers(), json=body, timeout=60)
        if r.status_code >= 400:
            if r.status_code in (401, 403):
                raise ApiError(502, "azure_auth", "Azure AI Search refused the sign-in. Run az login, and check your "
                                                  "account has the Search Index Data Contributor role.")
            raise ApiError(502, "azure_search", f"Azure AI Search returned {r.status_code}: {r.text[:300]}")
        return r.json() if r.content else None

    def index_exists(self, name: str) -> bool:
        return any(i["name"] == name for i in self._call("GET", "/indexes", None)["value"])

    def create_index(self, definition: dict) -> None:
        self._call("PUT", f"/indexes/{definition['name']}", definition)

    def upload(self, index: str, docs: list[dict]) -> None:
        self._call("POST", f"/indexes/{index}/docs/index", {"value": [{"@search.action": "mergeOrUpload", **d} for d in docs]})

    def count(self, index: str) -> int:
        return int(self._call("GET", f"/indexes/{index}/docs/$count") or 0)

    def hybrid(self, index: str, text: str, vector: list[float], top: int, select: list[str],
               semantic_config: str | None = None) -> list[dict]:
        """Keyword and vector search in one request; with a semantic configuration, the top results are reranked."""
        body: dict[str, Any] = {
            "search": text, "top": top, "select": ",".join(select),
            "vectorQueries": [{"kind": "vector", "vector": vector, "fields": "contentVector", "k": top * 2}],
        }
        if semantic_config:
            body.update({"queryType": "semantic", "semanticConfiguration": semantic_config})
        return self._call("POST", f"/indexes/{index}/docs/search", body)["value"]

    # ----- for the search pipeline lab -----
    def search(self, index: str, body: dict) -> dict:
        """Any search request: keyword, vector, hybrid or semantic, with captions and scores."""
        return self._call("POST", f"/indexes/{index}/docs/search", body)

    def delete_index(self, name: str) -> None:
        if self.index_exists(name):
            self._call("DELETE", f"/indexes/{name}")

    def index_stats(self, name: str) -> dict:
        return self._call("GET", f"/indexes/{name}/stats")

    def service_stats(self) -> dict:
        return self._call("GET", "/servicestats")
