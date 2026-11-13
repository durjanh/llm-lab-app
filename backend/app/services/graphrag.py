"""GraphRAG: a knowledge graph built from a collection's chunks, searched beside plain vector retrieval.

Building the graph: a model reads each chunk and lists the entities in it and the relationships between them (as
structured output). Code merges the same entity found in different chunks by its normalised name, finds communities
(groups of entities more connected to each other than to the rest, by the Louvain method), and a model writes a short
summary of each community. Everything is stored in PostgreSQL beside the chunks.

Asking: plain vector RAG answers from the chunks nearest the question. Local search starts from the entities nearest the
question and walks one or two relationships out, then answers from those entities, relationships and their chunks: good
for "who is X" and "who works with whom". Global search asks each community summary what it knows (map), then answers
from the best points (reduce): good for "what are the main themes", which no handful of chunks can answer.

The model extracts, summarises and writes; code merges, finds the communities, walks the graph and checks the citations.
"""
from __future__ import annotations

import contextvars
import json
import re
import time
from collections import Counter
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..gateways.graph_store import GraphStore, walk_sql
from ..gateways.local_embeddings import LocalEmbedder, LocalEmbeddingsUnavailable
from ..gateways.pgvector import VectorDbUnavailable, VectorStore
from ..shared import DEFAULT_MODEL, PRICES, text_of
from . import graphrag_sample
from .runs import Run, RunStreamer
from .spend import SpendTracker
from .vectordb import VectorDbService, cited

MAX_CHUNKS = 40  # per build: each chunk is one model call
MAX_COMMUNITIES = 12  # summarised, biggest first; the rest are too small to say much
MAX_DESCRIPTION = 600
TYPES = ["person", "team", "organisation", "project", "product", "place", "policy", "event", "other"]
# Rough tokens per call, for the estimate shown before a build: [input, output].
EXTRACT_TOKENS = (1100, 700)
SUMMARY_TOKENS = (1500, 300)

EXTRACT_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["entities", "relationships"],
    "properties": {
        "entities": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["name", "type", "description"],
            "properties": {"name": {"type": "string"}, "type": {"type": "string", "enum": TYPES},
                           "description": {"type": "string"}}}},
        "relationships": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["source", "target", "description", "strength"],
            "properties": {"source": {"type": "string"}, "target": {"type": "string"},
                           "description": {"type": "string"}, "strength": {"type": "integer"}}}},
    },
}

EXTRACT_SYSTEM = """You build a knowledge graph from documents. From the passage, list:
- entities: the people, teams, organisations, projects, products, places, policies and events it names. Use the name
  as written, in full (a person's full name, not a pronoun or a first name alone; "Project Heron", not "it"). The
  description says what the passage tells us about the entity, in one or two sentences.
- relationships between two of those entities that the passage states: source and target are entity names exactly as
  you listed them; the description says how they are related; strength is 1 (loosely) to 10 (directly and strongly).
Use only what the passage says. Skip generic things (dates, amounts, "the board" unless it acts as a body)."""

SUMMARY_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["title", "summary"],
    "properties": {"title": {"type": "string", "description": "a few words naming what the group is about"},
                   "summary": {"type": "string"}},
}

SUMMARY_SYSTEM = """You summarise one community in a knowledge graph: a group of entities more connected to each other
than to the rest. Give it a short title, then a summary of three to five sentences: who and what is in it, how they
relate, and the main facts, risks and decisions. Use only the entities and relationships given."""

MAP_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["points"],
    "properties": {"points": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["text", "importance"],
        "properties": {"text": {"type": "string"}, "importance": {"type": "integer"}}}}},
}

MAP_SYSTEM = """You are given a question and the summary of one part of a document collection. List the points from
this summary that help answer the question, each one sentence, with importance from 0 (barely) to 100 (central). If
nothing in it helps, return no points. Use only the summary."""

ANSWER_SYSTEM = """You answer a question using only the numbered evidence you are given, which a search found in a
document collection. Cite the evidence each statement comes from as [1], [2] and so on. If the evidence does not
contain the answer, say so plainly and say what it does cover; do not answer from general knowledge. Be brief: a few
sentences or a short list, plain British English. Write plain text, not Markdown: no ** or #; start each
list item with "- "."""


# ----- merging: the same entity found in several chunks -----

def normalise(name: str) -> str:
    """The key two mentions of the same entity share: lower case, no punctuation or leading "the"."""
    key = re.sub(r"['\u2019]", "", name.lower())  # "Bello's" -> "bellos", not "bello s"
    key = re.sub(r"[^\w&+ ]+", " ", key)
    key = re.sub(r"\s+", " ", key).strip()
    return re.sub(r"^the ", "", key)


def merge(extractions: list[tuple[dict[str, Any], dict[str, Any]]]) -> tuple[list[dict], list[dict]]:
    """One entity per normalised name, one relationship per pair, from (chunk ref, extraction) pairs. A relationship
    naming an entity no chunk listed adds that entity, typed "other", described by the relationship."""
    entities: dict[str, dict[str, Any]] = {}
    names: dict[str, Counter] = {}
    types: dict[str, Counter] = {}
    relations: dict[tuple[str, str], dict[str, Any]] = {}

    def add_ref(item: dict[str, Any], ref: dict[str, Any]) -> None:
        if ref not in item["refs"]:
            item["refs"].append(ref)

    def entity(name: str, type_: str, description: str, ref: dict[str, Any]) -> str | None:
        key = normalise(name)
        if not key:
            return None
        e = entities.setdefault(key, {"key": key, "descriptions": [], "refs": []})
        names.setdefault(key, Counter())[name.strip()] += 1
        types.setdefault(key, Counter())[type_ if type_ in TYPES else "other"] += 1
        d = description.strip()
        if d and d not in e["descriptions"]:
            e["descriptions"].append(d)
        add_ref(e, ref)
        return key

    for ref, got in extractions:
        for e in got.get("entities", []):
            entity(str(e.get("name", "")), str(e.get("type", "other")), str(e.get("description", "")), ref)
    for ref, got in extractions:
        for r in got.get("relationships", []):
            desc = str(r.get("description", "")).strip()
            a, b = normalise(str(r.get("source", ""))), normalise(str(r.get("target", "")))
            if not a or not b or a == b:
                continue
            for raw, key in ((r["source"], a), (r["target"], b)):
                if key not in entities:
                    entity(str(raw), "other", desc, ref)
            pair = (a, b) if a < b else (b, a)
            rel = relations.setdefault(pair, {"source": pair[0], "target": pair[1], "descriptions": [],
                                              "strength": 0.0, "refs": []})
            if desc and desc not in rel["descriptions"]:
                rel["descriptions"].append(desc)
            rel["strength"] = max(rel["strength"], float(min(10, max(1, int(r.get("strength", 1) or 1)))))
            add_ref(rel, ref)

    out_entities = []
    for key, e in entities.items():
        # the spelling used most, and the type given most (the first given wins a tie)
        out_entities.append({"key": key, "name": names[key].most_common(1)[0][0], "type": types[key].most_common(1)[0][0],
                             "description": " ".join(e["descriptions"])[:MAX_DESCRIPTION], "refs": e["refs"]})
    out_relations = [{"source": r["source"], "target": r["target"], "description": " ".join(r["descriptions"])[:400],
                      "strength": r["strength"], "refs": r["refs"]} for r in relations.values()]
    out_entities.sort(key=lambda e: e["key"])
    out_relations.sort(key=lambda r: (r["source"], r["target"]))
    return out_entities, out_relations


# ----- communities: Louvain, in plain Python, deterministic -----

def louvain(nodes: list[str], edges: list[tuple[str, str, float]]) -> dict[str, int]:
    """Each node's community, numbered from 0 by size (largest first). Louvain moves each node to the neighbouring
    community that most raises modularity (links inside groups beyond what chance would give), then treats each group
    as one node and repeats, until nothing moves. Nodes are visited in sorted order, so the answer is the same each time."""
    graph: dict[str, dict[str, float]] = {n: {} for n in nodes}
    for a, b, w in edges:
        if a == b or a not in graph or b not in graph:
            continue
        graph[a][b] = graph[a].get(b, 0.0) + w
        graph[b][a] = graph[b].get(a, 0.0) + w
    member: dict[str, str] = {n: n for n in nodes}  # original node -> its group in the current graph
    for _ in range(10):
        groups, moved = _one_level(graph)
        if not moved:
            break
        member = {n: groups[member[n]] for n in member}
        graph = _aggregate(graph, groups)
    sizes = Counter(member.values())
    order = sorted(sizes, key=lambda g: (-sizes[g], min(n for n in member if member[n] == g)))
    number = {g: i for i, g in enumerate(order)}
    return {n: number[member[n]] for n in nodes}


def _one_level(graph: dict[str, dict[str, float]]) -> tuple[dict[str, str], bool]:
    degree = {n: sum(links.values()) for n, links in graph.items()}
    total = sum(degree.values())
    group = {n: n for n in graph}
    if total == 0:
        return group, False
    tot = dict(degree)
    improved = False
    for _ in range(50):
        moved = False
        for n in sorted(graph):
            here = group[n]
            weights: dict[str, float] = {}
            for m, w in graph[n].items():
                if m != n:
                    weights[group[m]] = weights.get(group[m], 0.0) + w
            tot[here] -= degree[n]
            best, gain = here, weights.get(here, 0.0) - tot[here] * degree[n] / total
            for g in sorted(weights):
                score = weights[g] - tot[g] * degree[n] / total
                if score > gain + 1e-12:
                    best, gain = g, score
            tot[best] += degree[n]
            if best != here:
                group[n] = best
                moved = improved = True
        if not moved:
            break
    return group, improved


def _aggregate(graph: dict[str, dict[str, float]], group: dict[str, str]) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {g: {} for g in set(group.values())}
    for n, links in graph.items():
        for m, w in links.items():
            a, b = group[n], group[m]
            out[a][b] = out[a].get(b, 0.0) + w
    return out


def estimate(chunks: int, model: str) -> dict[str, Any]:
    """The calls a build makes and roughly what they cost, before it starts."""
    calls = min(chunks, MAX_CHUNKS)
    communities = min(MAX_COMMUNITIES, max(1, calls // 3))
    price = PRICES.get(model, {})
    cost = ((calls * EXTRACT_TOKENS[0] + communities * SUMMARY_TOKENS[0]) * price.get("input", 0)
            + (calls * EXTRACT_TOKENS[1] + communities * SUMMARY_TOKENS[1]) * price.get("output", 0)) / 1e6
    return {"chunks": chunks, "used": calls, "capped": chunks > MAX_CHUNKS, "calls": calls + communities,
            "cost_usd": round(cost, 4), "model": model}


def _refs(items: list[dict[str, Any]]) -> list[tuple[str, int]]:
    return [(r["source"], int(r["chunk"])) for item in items for r in item.get("refs", [])]


class GraphRagService:
    def __init__(self, store: VectorStore, graph: GraphStore, embedder: LocalEmbedder, claude: ClaudeGateway,
                 spend: SpendTracker, streamer: RunStreamer | None = None, workers: int = 4):
        self.store, self.graph, self.embedder, self.claude, self.spend = store, graph, embedder, claude, spend
        self.streamer, self.workers = streamer, workers
        self.vectors = VectorDbService(store, embedder, claude, spend)

    # ----- plumbing -----

    def _dims(self) -> int:
        return self.vectors._dimensions()

    def _db(self, call: Callable[..., Any], *args: Any) -> Any:
        try:
            return call(*args)
        except VectorDbUnavailable as exc:
            raise ApiError(503, "vector_db_unavailable", str(exc)) from exc

    def _embed(self, texts: list[str], kind: str) -> list[list[float]]:
        try:
            return self.embedder.embed(texts, kind)  # type: ignore[arg-type]
        except LocalEmbeddingsUnavailable as exc:
            raise ApiError(503, "local_embeddings_unavailable", str(exc)) from exc

    def _call(self, model: str, system: str, user: str, schema: dict | None, max_tokens: int) -> tuple[str, float]:
        params: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "system": system,
                                  "messages": [{"role": "user", "content": user}]}
        if schema:
            params["output_config"] = {"format": {"type": "json_schema", "schema": schema}}
        try:
            response = self.claude.create(**params)
        except Exception as exc:
            raise to_api_error(exc) from exc
        return text_of(response), self.spend.charge(response, model) or 0.0

    def _json(self, model: str, system: str, user: str, schema: dict, max_tokens: int) -> tuple[dict, float]:
        raw, cost = self._call(model, system, user, schema, max_tokens)
        try:
            return json.loads(raw), cost
        except json.JSONDecodeError:
            return {}, cost

    def _parallel(self, jobs: list[Callable[[], Any]]) -> list[Any]:
        """Runs jobs in threads (one at a time when workers is 1), each keeping this request's context for the call
        log. A job that raises returns its exception, so one failure does not lose the rest."""
        def safe(job: Callable[[], Any]) -> Any:
            try:
                return job()
            except Exception as exc:  # reported per job
                return exc
        if self.workers <= 1:
            return [safe(j) for j in jobs]
        with ThreadPoolExecutor(self.workers) as pool:
            futures = [pool.submit(contextvars.copy_context().run, safe, j) for j in jobs]
            return [f.result() for f in futures]

    # ----- status and samples -----

    def status(self, model: str | None) -> dict[str, Any]:
        model = model or DEFAULT_MODEL
        out: dict[str, Any] = {"sample": {"collection": graphrag_sample.COLLECTION, "title": graphrag_sample.TITLE,
                                          "documents": len(graphrag_sample.DOCUMENTS)},
                               "questions": {graphrag_sample.COLLECTION: graphrag_sample.QUESTIONS},
                               "limits": {"chunks": MAX_CHUNKS, "communities": MAX_COMMUNITIES},
                               "embedder": self.embedder.status(), "collections": []}
        if not out["embedder"].get("has_model"):
            return out
        try:
            dims = self._dims()
            out["collections"] = [{**c, "estimate": estimate(c["chunks"], model)}
                                  for c in self._db(self.graph.collections, self.embedder.model, dims)]
            out["dims"] = dims
        except ApiError as exc:
            out["error"] = exc.message
        return out

    def load_sample(self) -> dict[str, Any]:
        added = [self.vectors.add(graphrag_sample.COLLECTION, name, text)
                 for name, text in graphrag_sample.DOCUMENTS.items()]
        return {"collection": graphrag_sample.COLLECTION, "documents": len(added),
                "chunks": sum(a["chunks"] for a in added)}

    def graph_of(self, collection: str) -> dict[str, Any]:
        return self._db(self.graph.graph, self.embedder.model, self._dims(), collection)

    # ----- building -----

    def build(self, collection: str, model: str | None) -> Iterator[str]:
        """Builds the collection's graph, streamed: each chunk read, the merge, the communities, their summaries."""
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        model = model or DEFAULT_MODEL
        dims = self._dims()
        chunks = self._db(self.graph.chunks, self.embedder.model, dims, collection, MAX_CHUNKS + 1)
        if not chunks:
            raise ApiError(404, "not_found", f"The collection “{collection}” has no chunks for this embedding model. "
                                             "Add documents on the vector database page, or load the sample.")
        run = Run()
        return self.streamer.lines(run, lambda: self._build(run, collection, chunks, model, dims))

    def _build(self, run: Run, collection: str, chunks: list[dict[str, Any]], model: str, dims: int) -> None:
        started, cost = time.perf_counter(), 0.0
        if len(chunks) > MAX_CHUNKS:
            run.publish({"type": "note", "message": f"This collection has more than {MAX_CHUNKS} chunks; the graph is "
                                                    f"built from the first {MAX_CHUNKS}."})
            chunks = chunks[:MAX_CHUNKS]
        run.publish({"type": "progress", "step": f"Reading {len(chunks)} chunks with {model}", "done": 0,
                     "total": len(chunks)})
        done = 0

        def extract(c: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], float]:
            nonlocal done
            if run.cancelled.is_set():
                raise RuntimeError("cancelled")
            got, spent = self._json(model, EXTRACT_SYSTEM, f"Passage ({c['source']}, chunk {c['chunk']}):\n\n"
                                    f"{c['content']}", EXTRACT_SCHEMA, 2000)
            done += 1
            run.publish({"type": "chunk", "done": done, "total": len(chunks), "source": c["source"],
                         "chunk": c["chunk"], "entities": len(got.get("entities", [])),
                         "relationships": len(got.get("relationships", [])), "cost_usd": round(spent, 6)})
            return {"source": c["source"], "chunk": c["chunk"]}, got, spent

        results = self._parallel([lambda c=c: extract(c) for c in chunks])
        if run.cancelled.is_set():
            return
        good = [r for r in results if not isinstance(r, Exception)]
        failed = [r for r in results if isinstance(r, Exception)]
        cost += sum(r[2] for r in good)
        if failed:
            first = failed[0]
            run.publish({"type": "note", "message": f"{len(failed)} chunk(s) could not be read: "
                                                    f"{getattr(first, 'message', None) or first}"})
        if not good:
            run.publish({"type": "error", "message": "No chunk could be read, so there is no graph."})
            return
        entities, relations = merge([(ref, got) for ref, got, _ in good])
        mentions = sum(len(got.get("entities", [])) for _, got, _ in good)
        run.publish({"type": "merged", "mentions": mentions, "entities": len(entities), "relations": len(relations)})
        if not entities:
            run.publish({"type": "error", "message": "The model found no entities in these chunks."})
            return

        run.publish({"type": "progress", "step": "Embedding entity descriptions and finding communities"})
        vectors = self._embed([f"{e['name']} ({e['type']}): {e['description']}" for e in entities], "document")
        community = louvain([e["key"] for e in entities], [(r["source"], r["target"], r["strength"]) for r in relations])
        degree = Counter([r["source"] for r in relations] + [r["target"] for r in relations])
        for e, v in zip(entities, vectors):
            e.update(vector=v, community=community[e["key"]], degree=degree[e["key"]])
        members: dict[int, list[dict[str, Any]]] = {}
        for e in entities:
            members.setdefault(e["community"], []).append(e)
        groups = sorted((c for c, m in members.items() if len(m) >= 2), key=lambda c: -len(members[c]))
        run.publish({"type": "communities", "count": len(members), "summarised": min(len(groups), MAX_COMMUNITIES),
                     "sizes": [len(members[c]) for c in groups[:MAX_COMMUNITIES]]})

        run.publish({"type": "progress", "step": f"Summarising {min(len(groups), MAX_COMMUNITIES)} communities"})

        def summarise(c: int) -> tuple[dict[str, Any], float]:
            keys = {e["key"] for e in members[c]}
            lines = [f"- {e['name']} ({e['type']}): {e['description']}" for e in members[c][:30]]
            rels = [f"- {r['source']} — {r['target']}: {r['description']}" for r in relations
                    if r["source"] in keys and r["target"] in keys][:40]
            got, spent = self._json(model, SUMMARY_SYSTEM, "Entities:\n" + "\n".join(lines) + "\n\nRelationships:\n"
                                    + ("\n".join(rels) or "(none)"), SUMMARY_SCHEMA, 600)
            return {"community": c, "title": str(got.get("title") or f"Community {c}")[:120],
                    "summary": str(got.get("summary") or ""), "members": sorted(keys)}, spent

        summaries = []
        for got in self._parallel([lambda c=c: summarise(c) for c in groups[:MAX_COMMUNITIES]]):
            if isinstance(got, Exception):
                continue
            summaries.append(got[0])
            cost += got[1]
        if run.cancelled.is_set():
            return
        self._db(self.graph.replace, self.embedder.model, dims, collection, entities, relations, summaries)
        run.publish({"type": "done", "entities": len(entities), "relations": len(relations),
                     "communities": len(summaries), "cost_usd": round(cost, 6), "model": model,
                     "seconds": round(time.perf_counter() - started, 1)})

    # ----- asking -----

    def ask(self, collection: str, question: str, mode: str, model: str | None) -> dict[str, Any]:
        model = model or DEFAULT_MODEL
        started = time.perf_counter()
        if mode == "vector":
            evidence, highlight, extra = self._vector(collection, question)
        elif mode == "local":
            evidence, highlight, extra = self._local(collection, question)
        elif mode == "global":
            evidence, highlight, extra = self._global(collection, question, model)
        else:
            raise ApiError(400, "invalid_request", "mode must be vector, local or global.")
        cost = extra.pop("cost_usd", 0.0)
        if not evidence:
            return {"mode": mode, "answer": "The search found nothing to answer from.", "evidence": [], "cited": [],
                    "unknown": [], "highlight": highlight, "cost_usd": round(cost, 6), "model": None,
                    "ms": round((time.perf_counter() - started) * 1000), **extra}
        numbered = "\n\n".join(f"[{i}] {e['label']}\n{e['text']}" for i, e in enumerate(evidence, 1))
        answer, spent = self._call(model, ANSWER_SYSTEM, f"Evidence:\n\n{numbered}\n\nQuestion: {question}", None, 800)
        good, unknown = cited(answer, len(evidence))
        return {"mode": mode, "answer": answer.strip(), "evidence": evidence, "cited": good, "unknown": unknown,
                "highlight": highlight, "cost_usd": round(cost + spent, 6), "model": model,
                "ms": round((time.perf_counter() - started) * 1000), **extra}

    def _vector(self, collection: str, question: str) -> tuple[list[dict], dict, dict]:
        """Plain RAG: the chunks nearest the question by meaning."""
        [vector] = self._embed([question], "query")
        dims = len(vector)
        rows = self._db(self.store.search, self.embedder.model, dims, collection, question, vector, 5)["semantic"]["rows"]
        evidence = [{"kind": "chunk", "label": f"{r['source']}, chunk {r['chunk']}", "text": r["content"],
                     "ref": {"source": r["source"], "chunk": r["chunk"]}} for r in rows]
        refs = {(r["source"], r["chunk"]) for r in rows}
        try:
            graph = self._db(self.graph.graph, self.embedder.model, dims, collection)
            touched = [e["key"] for e in graph["entities"] if any((x["source"], x["chunk"]) in refs for x in e["refs"])]
        except ApiError:
            touched = []
        return evidence, {"entities": touched, "communities": []}, {}

    def _local(self, collection: str, question: str) -> tuple[list[dict], dict, dict]:
        """Local search: the nearest entities, a walk of up to two relationships, and the chunks they came from."""
        [vector] = self._embed([question], "query")
        dims = len(vector)
        seeds = self._db(self.graph.nearest, self.embedder.model, dims, collection, vector, 5)
        if not seeds:
            raise ApiError(409, "no_graph", "Build the graph for this collection first.")
        keys = [s["key"] for s in seeds]
        walked = self._db(self.graph.walk, self.embedder.model, dims, collection, keys, 2, 14)
        names = {e["key"]: e["name"] for e in self._db(self.graph.graph, self.embedder.model, dims, collection)["entities"]}
        counts = Counter(_refs(seeds))
        chunks = self._db(self.graph.chunk_texts, self.embedder.model, dims, collection,
                          [ref for ref, _ in counts.most_common(4)])
        evidence = (
            [{"kind": "entity", "label": f"{s['name']} ({s['type']}), similarity {s['similarity']:.2f}",
              "text": s["description"], "key": s["key"]} for s in seeds]
            + [{"kind": "relation", "label": f"{names.get(r['source'], r['source'])} — {names.get(r['target'], r['target'])}"
                f" (strength {r['strength']:g})", "text": r["description"], "keys": [r["source"], r["target"]]}
               for r in walked["relations"]]
            + [{"kind": "chunk", "label": f"{c['source']}, chunk {c['chunk']}", "text": c["content"],
                "ref": {"source": c["source"], "chunk": c["chunk"]}} for c in chunks])
        reached = sorted(walked["reached"], key=lambda k: (walked["reached"][k], k))
        return evidence, {"entities": reached, "seeds": keys, "communities": []}, {
            "sql": walk_sql(dims), "hops": {k: walked["reached"][k] for k in reached}}

    def _global(self, collection: str, question: str, model: str) -> tuple[list[dict], dict, dict]:
        """Global search: each community summary answers the question as best it can (map); the best points, from any
        community, become the evidence for one answer (reduce)."""
        graph = self._db(self.graph.graph, self.embedder.model, self._dims(), collection)
        communities = graph["communities"]
        if not communities:
            raise ApiError(409, "no_graph", "Build the graph for this collection first.")

        def ask_one(c: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], float]:
            got, spent = self._json(model, MAP_SYSTEM, f"Question: {question}\n\nSummary of “{c['title']}”:\n"
                                    f"{c['summary']}", MAP_SCHEMA, 600)
            return c, got, spent

        points, cost = [], 0.0
        for got in self._parallel([lambda c=c: ask_one(c) for c in communities]):
            if isinstance(got, Exception):
                continue
            c, answer, spent = got
            cost += spent
            for p in answer.get("points", []):
                importance = int(p.get("importance", 0) or 0)
                if importance > 0 and str(p.get("text", "")).strip():
                    points.append({"community": c["community"], "title": c["title"], "text": str(p["text"]).strip(),
                                   "importance": min(100, importance)})
        points.sort(key=lambda p: (-p["importance"], p["community"]))
        points = points[:15]
        evidence = [{"kind": "community", "label": f"Community {p['community']}: {p['title']} (importance "
                     f"{p['importance']})", "text": p["text"], "community": p["community"]} for p in points]
        used = sorted({p["community"] for p in points})
        return evidence, {"entities": [], "communities": used}, {"cost_usd": cost, "mapped": len(communities)}
