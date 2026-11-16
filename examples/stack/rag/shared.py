"""The RAG task and its check, shared by every tool (standard library only).

Each tool builds its own `answer(question) -> (answer_text, [retrieved section titles in rank order])`; `evaluate`
asks the 12 gold questions and counts correct answers and retrieval hits (gold section in the top 3).
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack
from common import checks, config, data  # noqa: E402,F401

SYSTEM = (
    "Answer the question using only the handbook excerpts given. Reply in one short sentence. "
    "If the excerpts do not contain the answer, say you do not know."
)


def prompt(question: str, passages: list[str]) -> str:
    context = "\n\n".join(f"[{i + 1}] {p}" for i, p in enumerate(passages))
    return f"Handbook excerpts:\n{context}\n\nQuestion: {question}"


def claude(question: str, passages: list[str]) -> str:
    """Generate with Claude from the passages (used by tools whose idiom has no Claude generator of its own)."""
    import anthropic

    reply = anthropic.Anthropic().messages.create(
        model=config.CLAUDE_MODEL, max_tokens=150, system=SYSTEM,
        messages=[{"role": "user", "content": prompt(question, passages)}])
    return "".join(b.text for b in reply.content if b.type == "text")


def evaluate(name: str, answer: Callable[[str], tuple[str, list[str]]], extra: str = "") -> bool:
    """Ask every gold question and print the result line."""
    correct, hits = [], []
    for g in data.GOLD:
        text, sections = answer(g.question)
        ok, hit = g.correct(text), g.section in sections[:3]
        correct.append(ok)
        hits.append(hit)
        print(f"  {'ok ' if ok else 'BAD'} {'hit ' if hit else 'miss'} {g.question} -> {text.strip()[:90]!r}", flush=True)
    detail = f"{checks.score(correct)} answers correct, {checks.score(hits)} retrieval hits" + (f"; {extra}" if extra else "")
    return checks.report(name, sum(correct) >= 11, detail)


def need_claude(name: str) -> bool:
    if not config.HAS_CLAUDE:
        checks.skip(name, "set ANTHROPIC_API_KEY (the lab's .env has it) to generate answers with Claude")
        return False
    return True

