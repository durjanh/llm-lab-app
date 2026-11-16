"""The one tiny RAG app every observability tool traces or evaluates, so the tools see the same work.

Retrieval is keyword overlap over the handbook chunks (standard library only). The answer is one Claude call over the
top two chunks. The six questions are the first six of common.data.GOLD, to keep the cost small.
"""
from __future__ import annotations

import math
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack
from common import config, data  # noqa: E402

MODEL = config.CLAUDE_MODEL
QUESTIONS = data.GOLD[:6]
SYSTEM = (
    "You answer questions about the Northwind staff handbook. Use only the context given. "
    "Answer in one short sentence with the exact figure. If the context does not say, reply 'I do not know'."
)
# claude-haiku-5-5 list price per million tokens (input, output), used where a tool wants a cost.
PRICE_PER_MTOK = (1.0, 5.0)
_STOP = set("a an the of in to is are do does can i my me what which how by on for at or and be it with from".split())
_CHUNKS = data.chunks()


def _words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9£]+", text.lower()) if w not in _STOP]


def retrieve(question: str, k: int = 2) -> list[str]:
    """Top-k chunk texts by TF-IDF-style keyword overlap with the question."""
    docs = [Counter(_words(c.text)) for c in _CHUNKS]
    df = Counter(w for d in docs for w in d)
    q = set(_words(question))
    scored = []
    for chunk, d in zip(_CHUNKS, docs):
        score = sum(math.log(1 + len(_CHUNKS) / df[w]) for w in q if w in d)
        scored.append((score, chunk.text))
    scored.sort(key=lambda s: -s[0])
    return [text for _, text in scored[:k]]


def user_prompt(question: str, contexts: list[str]) -> str:
    return "Context:\n" + "\n".join(f"- {c}" for c in contexts) + f"\n\nQuestion: {question}"


def cost(input_tokens: int, output_tokens: int) -> float:
    return (input_tokens * PRICE_PER_MTOK[0] + output_tokens * PRICE_PER_MTOK[1]) / 1_000_000


def generate(client, question: str, contexts: list[str]):
    """One Claude call (an anthropic client); returns the SDK message."""
    return client.messages.create(
        model=MODEL, max_tokens=150, system=SYSTEM,
        messages=[{"role": "user", "content": user_prompt(question, contexts)}])


def text_of(message) -> str:
    return "".join(b.text for b in message.content if getattr(b, "type", "") == "text").strip()


def answer(client, question: str) -> dict:
    """Retrieve, then answer. Returns question, contexts, answer, tokens and cost."""
    contexts = retrieve(question)
    msg = generate(client, question, contexts)
    return {"question": question, "contexts": contexts, "answer": text_of(msg),
            "input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens,
            "cost": cost(msg.usage.input_tokens, msg.usage.output_tokens)}


def answer_all(client) -> list[dict]:
    """Run the app on the six questions, each row carrying its gold pattern check."""
    rows = []
    for g in QUESTIONS:
        row = answer(client, g.question)
        row["gold"], row["correct"] = g.answer, g.correct(row["answer"])
        rows.append(row)
    return rows


if __name__ == "__main__":  # retrieval check, no model needed
    for g in QUESTIONS:
        top = retrieve(g.question)
        print(g.section, "->", [t.split(":")[0] for t in top], any(g.correct(t) for t in top))
