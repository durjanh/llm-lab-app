"""The vector database page: documents split into chunks, embedded by the open model on this machine, kept in
PostgreSQL with pgvector, and searched three ways (by meaning, by words, and both fused). A model can then answer a
question from the chunks found, citing them by number.

Each document carries metadata: an access group (who may read it) and tags (to filter by). Searches and answers run
as a chosen reader, and PostgreSQL's row-level security hides what that reader may not see, so a restricted chunk can
never reach the model's prompt for them.

Code does the retrieval and checks the citations; the model only writes the answer from what it was given.
"""
from __future__ import annotations

import re
import time
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..gateways.local_embeddings import LocalEmbedder, LocalEmbeddingsUnavailable
from ..gateways.pgvector import VectorDbUnavailable, VectorStore, create_sql
from ..shared import DEFAULT_MODEL, HANDBOOK, ROOT, text_of
from .spend import SpendTracker

CHUNK_CHARS = 700  # about 150 words: small enough to be about one thing, big enough to make sense alone
MAX_DOCUMENT_CHARS = 200_000
HEADING = re.compile(r"^#{1,6}\s+\S")
ACCESS = ["everyone", "hr", "managers"]  # who may read a document
READERS: dict[str, list[str]] = {  # the people a search can run as, and the groups each belongs to
    "Sam (staff)": ["everyone"],
    "Priya (HR)": ["everyone", "hr"],
    "Alex (manager)": ["everyone", "managers"],
}

# Invented restricted documents for the handbook collection: what permissions are for.
RESTRICTED = {
    "Salary bands 2026": ("""# Salary bands 2026 (HR only)

## Engineering
Junior engineer: £38,000 to £46,000. Engineer: £50,000 to £64,000. Senior engineer: £70,000 to £85,000.
Principal engineer: £90,000 to £110,000. Annual pay review in April; increases above 6% need HR director approval.

## Operations
Coordinator: £30,000 to £36,000. Operations manager: £52,000 to £62,000.""", "hr", ["pay"]),
    "Restructure plan (board)": ("""# Restructure plan, board only

## Proposal
Merge the Leeds and Bristol support teams into one team in Leeds by the end of Q2. About 14 roles are affected; the
plan offers relocation or voluntary redundancy. Staff are not to be told until consultation starts on 3 March.

## Budget
Relocation support up to £8,000 per person. Redundancy pay at twice the statutory rate.""", "managers", ["plans"]),
}


def samples() -> dict[str, dict[str, Any]]:
    """Sets of example documents, by key: the lab's invented handbook, and MedAssist's invented practice documents."""
    medassist = ROOT / "examples" / "medassist" / "knowledge"
    return {
        "handbook": {"collection": "handbook", "title": "Northwind employee handbook",
                     "documents": {"Northwind handbook": HANDBOOK}},
        "medassist": {"collection": "medassist", "title": "Harbourside Medical Centre (MedAssist)",
                      "documents": {p.stem: p.read_text() for p in sorted(medassist.glob("*.md"))}},
        "restricted": {"collection": "handbook", "title": "Restricted HR and board documents",
                       "documents": {name: text for name, (text, _, _) in RESTRICTED.items()},
                       "access": {name: (access, tags) for name, (_, access, tags) in RESTRICTED.items()}},
    }


def _sentences(text: str, size: int) -> list[str]:
    """A paragraph longer than a chunk, cut at sentence ends (and at spaces when one sentence is too long)."""
    pieces, current = [], ""
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        while len(sentence) > size:
            cut = sentence.rfind(" ", 0, size)
            cut = cut if cut > 0 else size
            pieces.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if current and len(current) + 1 + len(sentence) > size:
            pieces.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        pieces.append(current)
    return pieces


def chunk(text: str, size: int = CHUNK_CHARS) -> list[str]:
    """Splits a document into chunks of whole paragraphs (whole sentences when a paragraph is too long). Each chunk
    starts with the heading it sits under, so it still says what it is about when it is found on its own."""
    chunks: list[str] = []
    heading, body = "", ""

    def flush() -> None:
        nonlocal body
        if body.strip():
            chunks.append(f"{heading}\n{body}".strip() if heading and not body.startswith(heading) else body.strip())
        body = ""

    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n")):
        block = block.strip()
        if not block:
            continue
        lines = block.split("\n")
        if HEADING.match(lines[0]):
            flush()
            heading = lines[0].strip()
            block = "\n".join(lines[1:]).strip()
            if not block:
                continue
        room = size - len(heading) - 1
        for piece in ([block] if len(block) <= room else _sentences(block, room)):
            if body and len(body) + 2 + len(piece) > room:
                flush()
            body = f"{body}\n\n{piece}" if body else piece
    flush()
    return chunks


def cited(answer: str, count: int) -> tuple[list[int], list[int]]:
    """The chunk numbers an answer cites as [n], and any it cites that it was not given."""
    numbers = sorted({int(n) for n in re.findall(r"\[(\d{1,3})\]", answer)})
    return [n for n in numbers if 1 <= n <= count], [n for n in numbers if not 1 <= n <= count]


ANSWER_SYSTEM = """You answer a question using only the numbered passages you are given, which were found in a
document collection by a search. Cite the passage each statement comes from as [1], [2] and so on. If the passages do
not contain the answer, say so plainly and say what they do cover; do not answer from general knowledge. Be brief:
a few sentences, plain British English."""


class VectorDbService:
    def __init__(self, store: VectorStore, embedder: LocalEmbedder, claude: ClaudeGateway, spend: SpendTracker):
        self.store, self.embedder, self.claude, self.spend = store, embedder, claude, spend
        self._dims: int | None = None

    def _embed(self, texts: list[str], kind: str) -> tuple[list[list[float]], float]:
        started = time.perf_counter()
        try:
            vectors = self.embedder.embed(texts, kind)  # type: ignore[arg-type]
        except LocalEmbeddingsUnavailable as exc:
            raise ApiError(503, "local_embeddings_unavailable", str(exc)) from exc
        self._dims = len(vectors[0])
        return vectors, round((time.perf_counter() - started) * 1000, 1)

    def _dimensions(self) -> int:
        """The embedding model's vector length, asked once with a one-word text."""
        if self._dims is None:
            self._embed(["dimensions"], "document")
        assert self._dims is not None
        return self._dims

    def _db(self, call: Any, *args: Any) -> Any:
        try:
            return call(*args)
        except VectorDbUnavailable as exc:
            raise ApiError(503, "vector_db_unavailable", str(exc)) from exc

    def status(self) -> dict[str, Any]:
        embedder = self.embedder.status()
        out: dict[str, Any] = {"embedder": embedder, "database": self.store.status(), "chunk_chars": CHUNK_CHARS,
                               "readers": READERS, "access": ACCESS,
                               "samples": {k: {"title": v["title"], "collection": v["collection"],
                                               "documents": len(v["documents"])} for k, v in samples().items()}}
        ready = embedder.get("has_model") and out["database"].get("running")
        if ready:
            try:
                dims = self._dimensions()
                out["dims"], out["create_sql"] = dims, create_sql(dims)
                out["sources"] = self._db(self.store.sources, self.embedder.model, dims)
            except ApiError as exc:
                out["database"]["error"] = exc.message
        return out

    def add(self, collection: str, source: str, text: str, access: str = "everyone",
            tags: list[str] | None = None) -> dict[str, Any]:
        if access not in ACCESS:
            raise ApiError(400, "invalid_request", f"Access must be one of: {', '.join(ACCESS)}.")
        if len(text) > MAX_DOCUMENT_CHARS:
            raise ApiError(400, "invalid_request", f"A document can be up to {MAX_DOCUMENT_CHARS:,} characters.")
        chunks = chunk(text)
        if not chunks:
            raise ApiError(400, "invalid_request", "The document has no text.")
        vectors, embed_ms = self._embed(chunks, "document")
        started = time.perf_counter()
        self._db(self.store.add, self.embedder.model, len(vectors[0]), collection, source, chunks, vectors, access,
                 tags or [])
        return {"source": source, "collection": collection, "chunks": len(chunks), "dims": len(vectors[0]),
                "access": access, "tags": tags or [],
                "embed_ms": embed_ms, "store_ms": round((time.perf_counter() - started) * 1000, 1),
                "preview": [{"chunk": i, "content": c, "head": [round(x, 4) for x in v[:6]]}
                            for i, (c, v) in enumerate(zip(chunks[:3], vectors[:3]))]}

    def add_samples(self, key: str) -> dict[str, Any]:
        sample = samples().get(key)
        if not sample:
            raise ApiError(404, "not_found", "No such sample set.")
        meta = sample.get("access", {})
        added = [self.add(sample["collection"], name, text, *meta.get(name, ("everyone", [])))
                 for name, text in sample["documents"].items()]
        return {"collection": sample["collection"], "documents": len(added), "chunks": sum(a["chunks"] for a in added),
                "embed_ms": round(sum(a["embed_ms"] for a in added), 1)}

    def remove(self, collection: str, source: str | None) -> dict[str, Any]:
        rows = self._db(self.store.remove, self.embedder.model, self._dimensions(), collection, source)
        return {"deleted": rows}

    @staticmethod
    def groups_of(reader: str | None) -> list[str] | None:
        """The groups a reader belongs to; None (no reader) searches as the trusted server, seeing everything."""
        if reader is None:
            return None
        if reader not in READERS:
            raise ApiError(400, "invalid_request", f"Reader must be one of: {', '.join(READERS)}.")
        return READERS[reader]

    def search(self, collection: str, query: str, k: int, reader: str | None = None,
               tags: list[str] | None = None) -> dict[str, Any]:
        groups = self.groups_of(reader)
        [vector], embed_ms = self._embed([query], "query")
        found = self._db(self.store.search, self.embedder.model, len(vector), collection, query, vector, k, groups,
                         tags or None)
        return {**found, "embed_ms": embed_ms, "dims": len(vector), "model": self.embedder.model,
                "query_head": [round(x, 4) for x in vector[:6]], "reader": reader, "groups": groups}

    def answer(self, collection: str, query: str, k: int, model: str | None, reader: str | None = None,
               tags: list[str] | None = None) -> dict[str, Any]:
        found = self.search(collection, query, k, reader, tags)
        passages = found["hybrid"]["rows"]
        if not passages:
            return {"answer": "Nothing in this collection matched the question, so there is nothing to answer from.",
                    "passages": [], "cited": [], "unknown": [], "cost_usd": 0.0, "model": None}
        model = model or DEFAULT_MODEL
        numbered = "\n\n".join(f"[{i}] ({p['source']}, chunk {p['chunk']})\n{p['content']}"
                               for i, p in enumerate(passages, 1))
        try:
            response = self.claude.create(model=model, max_tokens=700, system=ANSWER_SYSTEM, messages=[
                {"role": "user", "content": f"Passages:\n\n{numbered}\n\nQuestion: {query}"}])
        except Exception as exc:
            raise to_api_error(exc) from exc
        cost = self.spend.charge(response, model) or 0.0
        answer = text_of(response).strip()
        good, unknown = cited(answer, len(passages))
        return {"answer": answer, "passages": passages, "cited": good, "unknown": unknown,
                "cost_usd": round(cost, 6), "model": model}
