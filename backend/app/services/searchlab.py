"""Search pipeline: ingest every modality into Azure AI Search, enrich it, query it four ways, and measure relevance.

Ingestion is a push pipeline written out step by step, so each step can be seen and timed: Content Understanding
extracts text from the documents, photos, video and audio (OCR, layout, descriptions and transcripts); the text is
chunked; Azure Language adds key phrases; text-embedding-3-small embeds each chunk; the chunks go into one index
with a vector field and a semantic configuration. An indexer with a skillset does the same work on a schedule from
a data source; its definition is shown for comparison. Then keyword, vector, hybrid and hybrid with the semantic
ranker are scored on labelled questions, and an agent uses the index as a tool.
"""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any

from ..core.errors import ApiError
from ..gateways.azure_search import AzureSearch
from ..gateways.foundry_tools import FoundryTools
from ..shared import LANGUAGE_PRICE_PER_1K_RECORDS, PRICES
from . import search_samples as samples
from .spend import SpendTracker
from .understanding import FILES, UnderstandingService

INDEX = "lab-claims"
SEMANTIC = "claims-semantic"
EMBED = "text-embedding-3-small"
DIMENSIONS = 1536
CHAT = "gpt-5.4-mini"
SOURCES = {  # index source id: (understanding sample, analyzer, modality, title)
    "doc-invoice": ("invoice", "prebuilt-layout", "document", "Decorator's invoice KD-20419"),
    "doc-claim": ("claim", "prebuilt-layout", "document", "Home insurance claim form"),
    "photo-ceiling": ("ceiling", "prebuilt-imageSearch", "image", "Photo: kitchen ceiling"),
    "photo-shelf": ("shelf", "prebuilt-imageSearch", "image", "Photo: shop shelf"),
    "photo-street": ("street", "prebuilt-imageSearch", "image", "Photo: street outside"),
    "media-video": ("video", "prebuilt-videoSearch", "video", "Claim video"),
}
MODES = ["keyword", "vector", "hybrid", "semantic"]


def chunks(text: str, size: int = 900, overlap: int = 100) -> list[str]:
    """Split on blank lines, then pack paragraphs into chunks of about `size` characters, overlapping a little."""
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    out: list[str] = []
    current = ""
    for p in paras:
        if current and len(current) + len(p) > size:
            out.append(current)
            current = current[-overlap:] + "\n\n" + p
        else:
            current = f"{current}\n\n{p}".strip()
    if current:
        out.append(current)
    return out


class SearchLabService:
    def __init__(self, tools: FoundryTools | None, search: AzureSearch | None, understanding: UnderstandingService,
                 spend: SpendTracker, folder: Path):
        self.tools, self.search, self.understanding, self.spend, self.folder = tools, search, understanding, spend, folder
        self.report: dict[str, Any] | None = None
        self._lock = threading.Lock()

    def _ready(self) -> tuple[FoundryTools, AzureSearch]:
        if self.tools is None or self.search is None:
            raise ApiError(503, "not_configured", "Set AZURE_LANGUAGE_ENDPOINT and AZURE_SEARCH_ENDPOINT in .env, run az "
                                                  "login, and restart the backend.")
        return self.tools, self.search

    def info(self) -> dict[str, Any]:
        exists = False
        if self.search is not None:
            try:
                exists = self.search.index_exists(INDEX)
            except ApiError:
                pass
        return {"configured": self.tools is not None and self.search is not None, "index": INDEX, "indexed": exists,
                "sources": [{"id": k, "title": v[3], "modality": v[2], "analyzer": v[1]} for k, v in SOURCES.items()]
                           + [{"id": k, "title": t, "modality": "text", "analyzer": "none"} for k, t, _ in samples.POLICY],
                "queries": [{"question": q, "expect": e} for q, e in samples.QUERIES], "modes": MODES,
                "skillset": samples.SKILLSET, "report": self.report, "embedding": EMBED, "dimensions": DIMENSIONS}

    # ----- ingestion -----
    def _extracted(self) -> dict[str, dict]:
        """Content Understanding output for each claim file, cached on disk: extraction is the costly step."""
        cache = self.folder / "extracted.json"
        return json.loads(cache.read_text()) if cache.exists() else {}

    def ingest(self) -> dict[str, Any]:
        tools, search = self._ready()
        with self._lock:
            steps: list[dict[str, Any]] = []
            cost = 0.0
            self.folder.mkdir(parents=True, exist_ok=True)

            t = time.perf_counter()
            extracted = self._extracted()
            fresh = 0
            for sid, (sample, analyzer, modality, title) in SOURCES.items():
                if sid in extracted:
                    continue
                try:
                    r = self.understanding.analyze(sample, analyzer)
                except ApiError as exc:
                    extracted[sid] = {"title": title, "modality": modality, "text": "", "error": exc.message}
                    continue
                summary = next((f["value"] for f in r["fields"] if f["name"] == "Summary"), "")
                transcript = " ".join(p["text"] for p in r["transcript"])
                text = "\n\n".join(x for x in [summary, transcript, r["markdown"] if modality == "document" else ""] if x)
                extracted[sid] = {"title": title, "modality": modality, "text": text, "analyzer": analyzer}
                cost += r["cost_usd"]
                fresh += 1
            (self.folder / "extracted.json").write_text(json.dumps(extracted))
            for pid, title, text in samples.POLICY:
                extracted[pid] = {"title": title, "modality": "text", "text": f"## {title}\n\n{text}"}
            steps.append({"step": "Extract with Content Understanding", "detail": f"{fresh} files analysed now, "
                          f"{len(SOURCES) - fresh} from cache; policy text taken as it is",
                          "ms": round((time.perf_counter() - t) * 1000)})

            t = time.perf_counter()
            docs: list[dict] = []
            problems = []
            for sid, e in extracted.items():
                parts = chunks(e["text"]) if e["text"] else []
                if not parts:
                    problems.append(f"{sid}: no text extracted{' (' + e['error'] + ')' if e.get('error') else ''}")
                for i, c in enumerate(parts):
                    docs.append({"id": f"{sid}-{i}", "source": sid, "title": e["title"], "modality": e["modality"], "chunk": c})
            lengths = [len(d["chunk"]) for d in docs]
            steps.append({"step": "Chunk", "detail": f"{len(docs)} chunks from {len(extracted)} sources, "
                          f"{min(lengths)} to {max(lengths)} characters (mean {sum(lengths) // len(lengths)})",
                          "ms": round((time.perf_counter() - t) * 1000)})

            t = time.perf_counter()
            for i in range(0, len(docs), 10):
                batch = docs[i:i + 10]
                res = tools.language("KeyPhraseExtraction", [{"id": str(j), "language": "en", "text": d["chunk"][:5000]}
                                                             for j, d in enumerate(batch)])
                for r in res:
                    batch[int(r["id"])]["keyPhrases"] = r["keyPhrases"][:12]
            cost += self.spend.charge_usd(len(docs) * LANGUAGE_PRICE_PER_1K_RECORDS / 1000, "Key phrases")
            steps.append({"step": "Enrich: key phrases (Azure Language)", "detail": f"{sum(len(d.get('keyPhrases', [])) for d in docs)} "
                          "key phrases, stored as a filterable field", "ms": round((time.perf_counter() - t) * 1000)})

            t = time.perf_counter()
            vectors, tokens = tools.embed([f"{d['title']}\n{d['chunk']}" for d in docs], EMBED)
            for d, v in zip(docs, vectors):
                d["contentVector"] = v
            cost += self.spend.charge_usd(tokens * PRICES[EMBED]["input"] / 1e6, EMBED)
            steps.append({"step": f"Embed ({EMBED})", "detail": f"{len(docs)} vectors of {DIMENSIONS} numbers, {tokens:,} tokens",
                          "ms": round((time.perf_counter() - t) * 1000)})

            t = time.perf_counter()
            search.delete_index(INDEX)
            search.create_index(self._definition())
            search.upload(INDEX, docs)
            steps.append({"step": "Index (Azure AI Search)", "detail": f"{len(docs)} documents into {INDEX}: BM25 on title, "
                          "chunk and key phrases; HNSW on the vectors; a semantic configuration", "ms": round((time.perf_counter() - t) * 1000)})
            self.report = {"steps": steps, "chunks": len(docs), "sources": len(extracted), "problems": problems,
                           "at": time.strftime("%H:%M:%S"), "cost_usd": round(cost, 6)}
            return {**self.report, "spent_usd": self.spend.spent_usd}

    def _definition(self) -> dict:
        return {
            "name": INDEX,
            "fields": [
                {"name": "id", "type": "Edm.String", "key": True, "filterable": True},
                {"name": "source", "type": "Edm.String", "filterable": True, "facetable": True},
                {"name": "title", "type": "Edm.String", "searchable": True},
                {"name": "modality", "type": "Edm.String", "filterable": True, "facetable": True},
                {"name": "chunk", "type": "Edm.String", "searchable": True, "analyzer": "en.microsoft"},
                {"name": "keyPhrases", "type": "Collection(Edm.String)", "searchable": True, "filterable": True},
                {"name": "contentVector", "type": "Collection(Edm.Single)", "searchable": True, "retrievable": False,
                 "dimensions": DIMENSIONS, "vectorSearchProfile": "default"},
            ],
            "vectorSearch": {"algorithms": [{"name": "hnsw", "kind": "hnsw", "hnswParameters": {"metric": "cosine"}}],
                             "profiles": [{"name": "default", "algorithm": "hnsw"}]},
            "semantic": {"configurations": [{"name": SEMANTIC, "prioritizedFields": {
                "titleField": {"fieldName": "title"}, "prioritizedContentFields": [{"fieldName": "chunk"}],
                "prioritizedKeywordsFields": [{"fieldName": "keyPhrases"}]}}]},
        }

    # ----- queries -----
    def _vector(self, text: str) -> list[float]:
        tools, _ = self._ready()
        [v], tokens = tools.embed([text], EMBED)
        self.spend.charge_usd(tokens * PRICES[EMBED]["input"] / 1e6, EMBED)
        return v

    def query(self, text: str, mode: str, top: int = 5, vector: list[float] | None = None) -> dict[str, Any]:
        if mode not in MODES:
            raise ApiError(400, "invalid_request", f"mode: choose one of {', '.join(MODES)}")
        _, search = self._ready()
        body: dict[str, Any] = {"top": top, "select": "id,source,title,modality,chunk,keyPhrases", "count": True}
        if mode in ("keyword", "hybrid", "semantic"):
            body["search"] = text
        if mode in ("vector", "hybrid", "semantic"):
            body["vectorQueries"] = [{"kind": "vector", "vector": vector or self._vector(text), "fields": "contentVector",
                                      "k": top * 2}]
        if mode == "semantic":
            body.update({"queryType": "semantic", "semanticConfiguration": SEMANTIC, "captions": "extractive",
                         "answers": "extractive|count-1"})
        started = time.perf_counter()
        r = search.search(INDEX, body)
        hits = [{"id": h["id"], "source": h["source"], "title": h["title"], "modality": h["modality"], "chunk": h["chunk"][:400],
                 "score": h.get("@search.score"), "reranker": h.get("@search.rerankerScore"),
                 "caption": ((h.get("@search.captions") or [{}])[0].get("text"))} for h in r.get("value", [])]
        return {"mode": mode, "hits": hits, "ms": round((time.perf_counter() - started) * 1000),
                "answer": ((r.get("@search.answers") or [{}])[0].get("text")), "spent_usd": self.spend.spent_usd}

    def evaluate(self) -> dict[str, Any]:
        """Every labelled question in every mode: where the expected source came, hit@1, hit@3 and mean reciprocal rank."""
        rows = []
        totals = {m: {"hit1": 0, "hit3": 0, "rr": 0.0, "ms": 0} for m in MODES}
        for question, expect in samples.QUERIES:
            vector = self._vector(question)  # one embedding per question, shared by the modes that need it
            row: dict[str, Any] = {"question": question, "expect": expect}
            for m in MODES:
                r = self.query(question, m, top=5, vector=vector)
                sources = [h["source"] for h in r["hits"]]
                rank = sources.index(expect) + 1 if expect in sources else None
                row[m] = {"rank": rank, "top": sources[0] if sources else None}
                t = totals[m]
                t["hit1"] += rank == 1
                t["hit3"] += bool(rank and rank <= 3)
                t["rr"] += 1 / rank if rank else 0
                t["ms"] += r["ms"]
            rows.append(row)
        n = len(samples.QUERIES)
        summary = {m: {"hit1": t["hit1"], "hit3": t["hit3"], "mrr": round(t["rr"] / n, 3), "ms": round(t["ms"] / n)} for m, t in totals.items()}
        return {"rows": rows, "summary": summary, "n": n, "spent_usd": self.spend.spent_usd}

    def health(self) -> dict[str, Any]:
        _, search = self._ready()
        index = search.index_stats(INDEX) if search.index_exists(INDEX) else None
        service = search.service_stats()
        return {"index": index, "counters": service.get("counters", {}), "report": self.report}

    # ----- retrieval as an agent's tool -----
    def ask(self, question: str) -> dict[str, Any]:
        tools, _ = self._ready()
        tool = {"type": "function", "function": {
            "name": "search_claim_file", "description": "Search the policy wording and this claim's documents, photos and "
                                                        "video. Returns the best passages with their source ids.",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"],
                           "additionalProperties": False}, "strict": True}}
        messages: list[dict] = [{"role": "system", "content": "You help a claims handler. Use search_claim_file before "
                                 "answering. Answer in two or three sentences and cite sources as [source id]. If the "
                                 "results do not say, say so."}, {"role": "user", "content": question}]
        steps, cost = [], 0.0
        for _ in range(4):
            r = tools.chat(CHAT, messages, tools=[tool], max_completion_tokens=600)
            u = r.get("usage") or {}
            cost += self.spend.charge_usd((u.get("prompt_tokens", 0) * PRICES[CHAT]["input"]
                                           + u.get("completion_tokens", 0) * PRICES[CHAT]["output"]) / 1e6, CHAT)
            msg = r["choices"][0]["message"]
            calls = msg.get("tool_calls") or []
            if not calls:
                return {"answer": msg.get("content") or "", "steps": steps, "cost_usd": round(cost, 6), "spent_usd": self.spend.spent_usd}
            messages.append({"role": "assistant", "content": msg.get("content"), "tool_calls": calls})
            for c in calls:
                q = json.loads(c["function"]["arguments"])["query"]
                found = self.query(q, "semantic", top=3)
                steps.append({"query": q, "sources": [h["source"] for h in found["hits"]]})
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(
                    [{"source": h["source"], "title": h["title"], "text": h["caption"] or h["chunk"]} for h in found["hits"]])})
        return {"answer": "(Stopped after four searches.)", "steps": steps, "cost_usd": round(cost, 6), "spent_usd": self.spend.spent_usd}
