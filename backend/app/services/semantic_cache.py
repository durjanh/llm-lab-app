"""The semantic cache page: a help desk that answers questions about the invented Northwind handbook, with a cache in
front of the model. A question close enough in meaning to one already answered gets the stored answer, with no model
call. The page shows the saving and the risk: two questions can be close in wording and differ in the one detail that
changes the answer.

Similarity alone is not enough: the trap pairs below score higher than true paraphrases. So a candidate above the
threshold must also pass two checks before it is served: code compares the numbers in the two questions, and a small
model, asked only "would these two questions have the same answer?", confirms it. Code decides every hit; the
answering model only writes answers on a miss.
"""
from __future__ import annotations

import json
import re
import threading
import time
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..gateways.local_embeddings import LocalEmbedder, LocalEmbeddingsUnavailable
from ..gateways.pgvector import VectorDbUnavailable
from ..gateways.semantic_cache import CacheStore, create_cache_sql, lookup_sql
from ..shared import DEFAULT_MODEL, HANDBOOK, text_of
from .spend import SpendTracker

PROMPT_VERSION = "handbook-v1"  # change it when the system prompt changes, so old answers stop matching
DEFAULT_THRESHOLD = 0.8
VERIFY_MODEL = "claude-haiku-5-5"  # the check is a yes or no, so the smallest model does it
NUMBER_WORDS = {w: str(i) for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve".split())}
DEFAULT_TTL_S = 24 * 3600
USERS = ["everyone", "sam", "alex"]  # "everyone" shares answers; a named user gets a cache of their own

SYSTEM = f"""You are Northwind's HR help desk. Answer the employee's question from the handbook below, in two or
three plain British English sentences. If the handbook does not say, say so.

{HANDBOOK}"""

# Pairs of questions, with whether a cache should treat them as the same question. The second group is the trap:
# nearly the same words, a different answer.
PAIRS: list[dict[str, Any]] = [
    {"a": "How many days of annual leave do I get?", "b": "What's my holiday allowance each year?", "same": True,
     "why": "Same question in different words."},
    {"a": "How do I claim expenses?", "b": "What's the process for getting reimbursed for work costs?", "same": True,
     "why": "Same question in different words."},
    {"a": "Can I work from home?", "b": "Am I allowed to work remotely?", "same": True,
     "why": "Same question in different words."},
    {"a": "How many days can I work remotely per week?", "b": "How many days can I work remotely from abroad per year?",
     "same": False, "why": "Three days a week at home, but 20 days a year abroad: one word changes the answer."},
    {"a": "Can I carry over 5 unused leave days?", "b": "Can I carry over 10 unused leave days?", "same": False,
     "why": "Up to 5 can be carried over, so the answers are yes and no."},
    {"a": "How do I book annual leave?", "b": "How do I cancel annual leave?", "same": False,
     "why": "Booking and cancelling are different processes."},
    {"a": "Is my learning budget £1,000?", "b": "Is my learning budget £500?", "same": False,
     "why": "One number differs; only one is true."},
]


def numbers(question: str) -> list[str]:
    """The numbers a question mentions, written as digits: "£1,000" and "1000" match, "five" and "5" match."""
    text = re.sub(r"(?<=\d),(?=\d{3})", "", question.lower())
    found = re.findall(r"\d+(?:\.\d+)?", text)
    found += [NUMBER_WORDS[w] for w in re.findall(r"[a-z]+", text) if w in NUMBER_WORDS]
    return sorted(found)


VERIFY_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["same_answer", "reason"],
    "properties": {"same_answer": {"type": "boolean"}, "reason": {"type": "string"}},
}
VERIFY_SYSTEM = """You check a cache. Say whether two questions an employee might ask would have exactly the same
correct answer. Different wording is fine. A different number, action, place, period or person means a different
answer. Reason in one short sentence."""


class SemanticCacheService:
    def __init__(self, store: CacheStore, embedder: LocalEmbedder, claude: ClaudeGateway, spend: SpendTracker):
        self.store, self.embedder, self.claude, self.spend = store, embedder, claude, spend
        self._lock = threading.Lock()
        self.stats = {"hits": 0, "misses": 0, "saved_usd": 0.0, "saved_ms": 0.0, "spent_usd": 0.0}

    def _embed(self, texts: list[str]) -> tuple[list[list[float]], float]:
        """Questions are compared with questions, so both sides are embedded the same way, as queries."""
        started = time.perf_counter()
        try:
            vectors = self.embedder.embed(texts, "query")
        except LocalEmbeddingsUnavailable as exc:
            raise ApiError(503, "local_embeddings_unavailable", str(exc)) from exc
        return vectors, round((time.perf_counter() - started) * 1000, 1)

    def _db(self, call: Any, *args: Any) -> Any:
        try:
            return call(*args)
        except VectorDbUnavailable as exc:
            raise ApiError(503, "vector_db_unavailable", str(exc)) from exc

    @staticmethod
    def scope(model: str, user: str) -> str:
        return f"{model} | {PROMPT_VERSION} | {user}"

    def status(self) -> dict[str, Any]:
        embedder = self.embedder.status()
        out: dict[str, Any] = {"embedder": embedder, "database": self.store.status(), "users": USERS,
                               "threshold": DEFAULT_THRESHOLD, "ttl_s": DEFAULT_TTL_S, "prompt_version": PROMPT_VERSION,
                               "stats": dict(self.stats), "pairs": [{k: p[k] for k in ("a", "b", "same", "why")}
                                                                    for p in PAIRS]}
        if embedder.get("has_model") and out["database"].get("running"):
            try:
                [v], _ = self._embed(["dimensions"])
                out["dims"] = len(v)
                out["create_sql"], out["lookup_sql"] = create_cache_sql(len(v)), lookup_sql(len(v))
                out["entries"] = self._db(self.store.entries, len(v), self.embedder.model, None)
            except ApiError as exc:
                out["database"]["error"] = exc.message
        return out

    def pairs(self) -> dict[str, Any]:
        """The similarity of each preset pair: free, from the local embedding model alone."""
        vectors, ms = self._embed([q for p in PAIRS for q in (p["a"], p["b"])])
        rows = []
        for i, p in enumerate(PAIRS):
            a, b = vectors[2 * i], vectors[2 * i + 1]
            rows.append({**p, "similarity": round(sum(x * y for x, y in zip(a, b)), 4),
                         "numbers_match": numbers(p["a"]) == numbers(p["b"])})
        return {"pairs": rows, "embed_ms": ms, "model": self.embedder.model}

    def verify(self, a: str, b: str) -> tuple[bool, str, float]:
        """A small model's yes or no: would the two questions have the same answer? With its reason and cost."""
        try:
            response = self.claude.create(
                model=VERIFY_MODEL, max_tokens=200, system=VERIFY_SYSTEM,
                messages=[{"role": "user", "content": f"Question A: {a}\nQuestion B: {b}"}],
                output_config={"format": {"type": "json_schema", "schema": VERIFY_SCHEMA}})
        except Exception as exc:
            raise to_api_error(exc) from exc
        cost = self.spend.charge(response, VERIFY_MODEL) or 0.0
        try:
            verdict = json.loads(text_of(response))
            return bool(verdict["same_answer"]), str(verdict["reason"]), cost
        except (ValueError, KeyError, TypeError):
            return False, "The check did not answer clearly, so the cached answer was not used.", cost

    def verify_pairs(self) -> dict[str, Any]:
        """The model check on every preset pair, to compare with similarity and the number check."""
        rows, total = [], 0.0
        for p in PAIRS:
            same, reason, cost = self.verify(p["a"], p["b"])
            total += cost
            rows.append({"a": p["a"], "b": p["b"], "same_answer": same, "reason": reason})
        return {"pairs": rows, "cost_usd": round(total, 6), "model": VERIFY_MODEL}

    def ask(self, question: str, model: str | None, user: str, threshold: float, ttl_s: int,
            use_cache: bool, check_numbers: bool = True, check_model: bool = True) -> dict[str, Any]:
        if user not in USERS:
            raise ApiError(400, "invalid_request", f"User must be one of: {', '.join(USERS)}.")
        model = model or DEFAULT_MODEL
        started = time.perf_counter()
        [vector], embed_ms = self._embed([question])
        dims, scope = len(vector), self.scope(model, user)
        lookup_started = time.perf_counter()
        near = self._db(self.store.nearest, dims, self.embedder.model, scope, vector, 3, ttl_s) if use_cache else []
        lookup_ms = round((time.perf_counter() - lookup_started) * 1000, 1)
        best = near[0] if near else None

        # Each candidate above the threshold, closest first, must pass the checks that are switched on.
        checked: list[dict[str, Any]] = []
        check_cost = 0.0
        chosen = None
        for c in (n for n in near if use_cache and n["similarity"] >= threshold):
            if check_numbers and numbers(c["question"]) != numbers(question):
                checked.append({"id": c["id"], "passed": False, "by": "numbers",
                                "reason": f"Numbers differ: {numbers(question) or 'none'} against "
                                          f"{numbers(c['question']) or 'none'}."})
                continue
            if check_model:
                same, reason, cost = self.verify(question, c["question"])
                check_cost += cost
                if not same:
                    checked.append({"id": c["id"], "passed": False, "by": "model", "reason": reason})
                    continue
                checked.append({"id": c["id"], "passed": True, "by": "model", "reason": reason})
            else:
                checked.append({"id": c["id"], "passed": True, "by": "threshold", "reason": "Close enough."})
            chosen = c
            break

        if chosen:
            self._db(self.store.hit, dims, chosen["id"])
            total_ms = round((time.perf_counter() - started) * 1000, 1)
            saved = max(0.0, chosen["cost_usd"] - check_cost)
            with self._lock:
                self.stats["hits"] += 1
                self.stats["saved_usd"] += saved
                self.stats["spent_usd"] += check_cost
                self.stats["saved_ms"] += max(0.0, chosen["ms"] - total_ms)
            return {"hit": True, "answer": chosen["answer"], "matched": chosen["question"],
                    "similarity": chosen["similarity"], "neighbours": near, "checked": checked, "scope": scope,
                    "embed_ms": embed_ms, "lookup_ms": lookup_ms, "total_ms": total_ms,
                    "cost_usd": round(check_cost, 6), "saved_usd": round(saved, 6), "model_ms": chosen["ms"],
                    "stats": dict(self.stats)}

        model_started = time.perf_counter()
        try:
            response = self.claude.create(model=model, max_tokens=400, system=SYSTEM,
                                          messages=[{"role": "user", "content": question}])
        except Exception as exc:
            raise to_api_error(exc) from exc
        model_ms = round((time.perf_counter() - model_started) * 1000, 1)
        cost = (self.spend.charge(response, model) or 0.0) + check_cost
        answer = text_of(response).strip()
        if use_cache and answer:
            self._db(self.store.put, dims, self.embedder.model, scope, question, answer, vector, cost, model_ms)
        with self._lock:
            self.stats["misses"] += 1
            self.stats["spent_usd"] += cost
        return {"hit": False, "answer": answer, "matched": None,
                "similarity": best["similarity"] if best else None, "neighbours": near, "checked": checked,
                "scope": scope,
                "embed_ms": embed_ms, "lookup_ms": lookup_ms, "model_ms": model_ms,
                "total_ms": round((time.perf_counter() - started) * 1000, 1), "cost_usd": round(cost, 6),
                "saved_usd": 0.0, "stats": dict(self.stats)}

    def clear(self) -> dict[str, Any]:
        [vector], _ = self._embed(["dimensions"])
        deleted = self._db(self.store.clear, len(vector), self.embedder.model)
        with self._lock:
            self.stats = {"hits": 0, "misses": 0, "saved_usd": 0.0, "saved_ms": 0.0, "spent_usd": 0.0}
        return {"deleted": deleted}
