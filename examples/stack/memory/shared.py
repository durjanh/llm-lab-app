"""The memory area's task: a two-session conversation, five questions that need what Sam said, and the scoring.

Session 1: Sam states five facts over a few turns and corrects one of them. Session 2 is a new conversation for the
same user id with no history: five questions that only memory (and, for two of them, a handbook rule) can answer.
Every tool stores session 1 its own way, recalls for each session 2 question, and hands the recalled lines to
`evaluate`, which asks Claude to answer and checks each answer with regular expressions.

The module itself uses the standard library. Claude and the local embedder are imported only when called, so each
tool's virtual environment needs `anthropic` (and `fastembed` for local embeddings) only if it uses those helpers.
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack
from common import checks, config, data  # noqa: E402

USER_ID = "sam"
SESSION_1 = "session-1"
SESSION_2 = "session-2"

# Session 1: five facts, and the correction of one of them in the last turn. (user message, assistant reply)
SESSION_1_TURNS: list[tuple[str, str]] = [
    ("Hi, I'm Sam and I work in the Leeds office. I'm vegetarian, so please remember that for any food bookings.",
     "Nice to meet you, Sam. I'll remember that you are vegetarian and based in Leeds."),
    ("I want to put in a learning-budget request for a data engineering course. It costs £600.",
     "Good idea. I've noted a £600 data engineering course request."),
    ("For work trips I much prefer trains to flights.",
     "Understood, trains first."),
    ("My manager is Priya, so send anything that needs sign-off to her.",
     "Noted: Priya is your manager."),
    ("Also, I'm going on parental leave in March.",
     "Congratulations. I've noted that your parental leave starts in March."),
    ("Actually, I checked the invoice and the course costs £450, not £600.",
     "Thanks, I'll use £450 for the course from now on."),
]


@dataclass(frozen=True)
class Question:
    text: str
    patterns: tuple[str, ...]  # every pattern must match the answer
    section: str  # the handbook section that holds the rule, "" when memory alone answers it
    forbidden: str = ""  # a pattern that must not match (the stale value)


QUESTIONS: list[Question] = [
    Question("What does my course cost and does it need approval?", (r"£\s?450", r"\b(no|not|doesn't|does not|don't|without)\b"),
             "Learning and development", forbidden=r"(costs?|is|at|of|for)\s+£\s?600"),
    Question("I have a client meeting in Edinburgh next month. How should I travel?", (r"\b(train|rail)",), "Travel"),
    Question("Who is my line manager and which office do I work from?", (r"Priya", r"Leeds"), ""),
    Question("I'm booking lunch for a team event. What should I tell the caterer about me?", (r"vegetarian",), ""),
    Question("When does my parental leave start, and how much notice must I give HR?", (r"March", r"\b15\b|fifteen"),
             "Parental leave"),
]
CORRECTED_FACT = "£450"  # the corrected course cost must win over £600
PASS_MARK = 4


def handbook_section(title: str) -> str:
    """The text of one handbook section, or empty for no section."""
    return next((f"{t}: {x}" for t, x in data.SECTIONS if t == title), "")


def check_answer(q: Question, answer: str) -> bool:
    ok = all(re.search(p, answer, flags=re.I) for p in q.patterns)
    return ok and not (q.forbidden and re.search(q.forbidden, answer, flags=re.I))


_client = None


def claude(prompt: str, system: str = "", max_tokens: int = 2000) -> str:
    """One short Claude call (the cheapest model; the token limit leaves room for its thinking); the key comes from the environment and is never printed."""
    global _client
    import anthropic

    _client = _client or anthropic.Anthropic()
    msg = _client.messages.create(model=config.CLAUDE_MODEL, max_tokens=max_tokens, system=system or anthropic.NOT_GIVEN,
                                  messages=[{"role": "user", "content": prompt}])
    return "".join(b.text for b in msg.content if b.type == "text").strip()


def answer(q: Question, memories: list[str]) -> str:
    """Claude answers from the recalled memory lines and the handbook section the question needs."""
    lines = "\n".join(f"- {m}" for m in memories) or "(nothing recalled)"
    rule = handbook_section(q.section)
    prompt = (f"What you remember about the user from earlier conversations:\n{lines}\n\n"
              + (f"Handbook section:\n{rule}\n\n" if rule else "")
              + f"Question: {q.text}\n\nAnswer in one or two sentences. Where memories disagree, trust the newest.")
    return claude(prompt, "You are a workplace assistant for Northwind. Use only the memories and handbook given.")


def evaluate(name: str, recall: Callable[[str], list[str]] | None, extra: str = "",
             respond: Callable[[Question], tuple[str, int]] | None = None) -> bool:
    """Run the five session 2 questions, score and print the result line.

    Normally `recall` returns memory lines and Claude answers from them. A tool whose agent answers for itself (Letta)
    passes `respond` instead: it takes the question and returns (reply, number of memories it used).
    """
    results, first = [], ""
    for i, q in enumerate(QUESTIONS, 1):
        if respond:
            reply, n = respond(q)
        else:
            memories = recall(q.text)
            n = len(memories)
            reply = answer(q, memories)
        ok = check_answer(q, reply)
        results.append(ok)
        first = reply if i == 1 else first
        print(f"Q{i} {'ok  ' if ok else 'MISS'} {q.text}\n     recalled {n} | {reply}", flush=True)
    wins = bool(re.search(r"£\s?450", first)) and not (QUESTIONS[0].forbidden and re.search(QUESTIONS[0].forbidden, first, re.I))
    passed = sum(results) >= PASS_MARK and wins
    detail = f"{checks.score(results)} answers correct, corrected fact {CORRECTED_FACT} {'won' if wins else 'LOST'}"
    return checks.report(name, passed, detail + (f"; {extra}" if extra else ""))


# Helpers for tools that build their own store -----------------------------------------------------------------

EXTRACT_SYSTEM = (
    "You maintain a user's long-term memory. Given the existing memories (id: text) and the user's newest message, "
    "reply with JSON only: {\"add\": [\"short third-person fact\", ...], \"supersede\": [ids of existing memories "
    "the new message corrects or replaces]}. Only store lasting facts and preferences about the user, and keep specific values (amounts, names, dates) in the fact. Write each fact "
    "as a complete sentence, for example \"Sam's course costs £450.\" Use empty lists when nothing is worth storing.")


def extract(message: str, existing: list[tuple[str, str]]) -> dict:
    """Ask Claude which facts a message adds and which stored memories it supersedes."""
    listing = "\n".join(f"{i}: {t}" for i, t in existing) or "(none)"
    raw = claude(f"Existing memories:\n{listing}\n\nNewest message from Sam: {message}", EXTRACT_SYSTEM)
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        out = json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        out = {}
    return {"add": [str(x) for x in out.get("add", [])], "supersede": [str(x) for x in out.get("supersede", [])]}


TRIPLES_SYSTEM = (
    "Extract facts from the user's message as knowledge-graph triples. Reply with JSON only: a list of "
    "[subject, relation, object] with short relation names in UPPER_SNAKE_CASE (WORKS_IN, DIET, PREFERS, MANAGER, "
    "LEAVE_STARTS, COURSE_COST). Subject is \"Sam\" for facts about the user. Use one relation name for one kind of "
    "fact, so a corrected fact reuses the same subject and relation as the stored fact it corrects, spelled exactly the same.")


def triples(message: str, existing: list[tuple[str, str, str]] = ()) -> list[tuple[str, str, str]]:
    """Triples a message states. The graph's current facts are shown so a correction reuses the same subject and relation."""
    known = "\n".join(f"[{s}, {r}, {o}]" for s, r, o in existing) or "(none)"
    raw = claude(f"Facts already stored:\n{known}\n\nNewest message from Sam: {message}", TRIPLES_SYSTEM)
    m = re.search(r"\[.*\]", raw, re.S)
    try:
        return [tuple(map(str, t)) for t in json.loads(m.group(0)) if len(t) == 3] if m else []
    except json.JSONDecodeError:
        return []


_embedder = None


def embed(texts: list[str]) -> list[list[float]]:
    """Local BGE small embeddings (384 dimensions) through fastembed: no key, no cost."""
    global _embedder
    from fastembed import TextEmbedding

    _embedder = _embedder or TextEmbedding(config.LOCAL_EMBEDDING)
    return [v.tolist() for v in _embedder.embed(texts)]


EMBED_DIM = 384
