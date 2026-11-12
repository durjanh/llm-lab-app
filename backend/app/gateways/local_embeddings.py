"""An open embedding model on this machine, served by Docker Model Runner's OpenAI-style API (/embeddings on
LLM_LAB_LOCAL_OPENAI_URL). It costs nothing and the text never leaves the machine.

Some embedding models are trained with a short instruction in front of each text, different for a stored passage and
for a question. The model's card says which; PREFIXES holds the ones we know, so callers only say which kind a text is.
"""
from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from typing import Any, Callable, Literal, Protocol

Kind = Literal["document", "query"]
BATCH = 32  # texts per request to the local server

# What each model family expects in front of a text. A model not listed gets the text as it is.
PREFIXES: dict[str, dict[str, str]] = {
    "nomic-embed-text": {"document": "search_document: ", "query": "search_query: "},
    "mxbai-embed": {"document": "", "query": "Represent this sentence for searching relevant passages: "},
    "embeddinggemma": {"document": "title: none | text: ", "query": "task: search result | query: "},
}


class LocalEmbeddingsUnavailable(RuntimeError):
    """No local embedding model is set up, or the local server did not answer."""


class LocalEmbedder(Protocol):
    model: str

    def status(self) -> dict[str, Any]: ...
    def embed(self, texts: list[str], kind: Kind = "document") -> list[list[float]]: ...


def prefix_for(model: str, kind: str) -> str:
    name = model.lower()
    for family, prefixes in PREFIXES.items():
        if family in name:
            return prefixes.get(kind, "")
    return ""


def _post(url: str, body: dict, timeout_s: float) -> dict:
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        return json.loads(response.read())


def _get(url: str, timeout_s: float) -> dict:
    with urllib.request.urlopen(url, timeout=timeout_s) as response:
        return json.loads(response.read())


class LocalEmbeddings:
    def __init__(self, model: str, url: str, timeout_s: float = 60.0,
                 post: Callable[[str, dict, float], dict] = _post, get: Callable[[str, float], dict] = _get):
        self.model, self.url, self.timeout_s = model.strip(), url.rstrip("/"), timeout_s
        self._post, self._get = post, get

    def status(self) -> dict[str, Any]:
        """Whether a model is configured, the server is up and it has the model. Never raises."""
        if not self.model:
            return {"configured": False}
        try:
            ids = [m.get("id", "") for m in self._get(f"{self.url}/models", 2.0).get("data", [])]
        except Exception:
            return {"configured": True, "running": False, "has_model": False, "model": self.model}
        return {"configured": True, "running": True, "has_model": any(_same_model(self.model, i) for i in ids),
                "model": self.model}

    def embed(self, texts: list[str], kind: Kind = "document") -> list[list[float]]:
        """One unit-length vector per text, in order."""
        if not self.model:
            raise LocalEmbeddingsUnavailable("No local embedding model is set up. Run ./tools/local-model.sh --embed, "
                                             "add LLM_LAB_LOCAL_EMBED_MODEL to .env, and restart the backend.")
        prefix = prefix_for(self.model, kind)
        vectors: list[list[float]] = []
        for start in range(0, len(texts), BATCH):
            batch = [prefix + t for t in texts[start:start + BATCH]]
            try:
                reply = self._post(f"{self.url}/embeddings", {"model": self.model, "input": batch}, self.timeout_s)
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode(errors="replace")[:200]
                raise LocalEmbeddingsUnavailable(f"The local server refused the request (HTTP {exc.code}). Is "
                                                 f"{self.model} pulled? `docker model pull {self.model}`. {detail}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                raise LocalEmbeddingsUnavailable(f"The local model server at {self.url} did not answer. Start Docker "
                                                 f"Desktop, or run ./tools/local-model.sh --embed. ({exc})") from exc
            rows = sorted(reply.get("data", []), key=lambda r: r.get("index", 0))
            if len(rows) != len(batch):
                raise LocalEmbeddingsUnavailable("The local server returned a different number of vectors than texts.")
            vectors += [_unit(r["embedding"]) for r in rows]
        return vectors


def _same_model(wanted: str, listed: str) -> bool:
    """ai/nomic-embed-text-v1.5 is listed as docker.io/ai/nomic-embed-text-v1.5:latest: compare name and tag only."""
    def parts(name: str) -> tuple[str, str]:
        last = name.lower().split("/")[-1]
        base, _, tag = last.partition(":")
        return base, tag or "latest"
    return parts(wanted) == parts(listed)


def _unit(v: list[float]) -> list[float]:
    """The vector scaled to length 1, so a dot product is the cosine similarity."""
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]
