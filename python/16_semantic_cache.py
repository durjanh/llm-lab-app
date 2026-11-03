"""Semantic caching: answer a question from the cache when an earlier one meant the same thing.

Companion to the Context & cost and Embeddings & RAG labs. A stream of employee questions about the
handbook arrives in order. Each question is embedded on this machine (all-MiniLM-L6-v2 through
fastembed, free); if an earlier question is close enough, its answer is served again and Claude is not
called. The same stream is replayed under several policies:

  no cache      every question goes to Claude
  threshold t   reuse the nearest earlier answer when cosine similarity is at least t
  verified      above a lower threshold, a cheap Claude check reads the cached answer and the new
                question and decides whether the answer still fits; anything above --sure is reused unchecked

Every question carries a label naming what it really asks, so each reuse is scored: a wrong hit serves
one person's answer to another person's question. The stream includes rewordings ("How much holiday do I
get?" after "How many days of annual leave do I get?") and near misses that embed almost the same but need
a different answer (a hotel in London against one in Manchester; leave days against sick-pay days). The
lower the threshold, the more you save and the more wrong answers you serve; the check buys back accuracy.
Scoring by label is strict: a cached answer that happens to mention both facts still counts as wrong.

A check is a model call too, so it pays only when an answer costs much more than a check. The table also
shows the saving if each answer cost 10 or 40 times as much (a larger model, a long context, an agent run)
with the check unchanged.

Claude answers each distinct question once, so trying policies costs nothing extra. In production, also
key the cache by everything the answer depends on (the handbook version, the tenant, the user for
personal questions), give entries an expiry, and never cache answers about one person's own data.

    python 16_semantic_cache.py --embed-only     # similarities and hits only; no API calls, no cost
    python 16_semantic_cache.py
    python 16_semantic_cache.py --thresholds 0.8 0.7 --check-from 0.6 --verbose
"""
from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from common import cost_usd, create, ensure_answered, make_client, model_argument, run, text_of
from data import HANDBOOK

# (question, what it really asks). Two questions with the same label have the same right answer.
STREAM: list[tuple[str, str]] = [
    ("How many days of annual leave do I get?", "leave days"),
    ("How much can I spend on a hotel in London?", "hotel London"),
    ("What do I do if my laptop is stolen?", "lost laptop"),
    ("How many days a week can I work from home?", "remote days"),
    ("How much holiday am I entitled to each year?", "leave days"),
    ("How many days of sick pay do I get?", "sick pay"),
    ("What's the nightly hotel limit in London?", "hotel London"),
    ("How much can I spend on a hotel in Manchester?", "hotel UK"),
    ("Can I carry unused leave into next year?", "leave carry-over"),
    ("What is my yearly training budget?", "learning budget"),
    ("I lost my laptop, who should I tell?", "lost laptop"),
    ("How many days can I work from abroad?", "abroad days"),
    ("How often am I allowed to work remotely?", "remote days"),
    ("How much paid leave do partners get after a birth?", "partner leave"),
    ("Does unused learning budget carry over?", "learning carry-over"),
    ("How much can I spend on meals when travelling for work?", "meals"),
    ("How much maternity leave do birth parents get?", "birth parent leave"),
    ("Do leftover holiday days roll over to next year?", "leave carry-over"),
    ("What is the mileage rate for using my own car?", "mileage"),
    ("How much can I spend on courses each year?", "learning budget"),
    ("What's the daily food allowance on a business trip?", "meals"),
    ("How long is paternity leave for partners?", "partner leave"),
    ("What's the hotel cap per night outside London?", "hotel UK"),
    ("How long is company sick pay paid for?", "sick pay"),
    ("How much does the company pay into my pension?", "pension"),
    ("What is my annual vacation allowance?", "leave days"),
    ("Do I have to declare a gift from a supplier?", "gifts"),
    ("How long can I self-certify when I'm ill?", "self-certify"),
    ("Can I work remotely from another country, and for how long?", "abroad days"),
    ("What's the pension contribution from the employer?", "pension"),
]

SYSTEM = ("You answer employees' questions from the handbook below, in one or two sentences, with the exact "
          "figures. If the handbook does not say, say so.\n\n" + HANDBOOK)

CHECK_SYSTEM = ("A cache holds an answer given to an earlier question. Decide whether that answer correctly and "
                "fully answers the new question. Reject it if the new question differs in anything that changes "
                "the answer: a place, a person, an amount, a time period or a different policy.")
CHECK_SCHEMA = {"type": "object", "properties": {"reuse": {"type": "boolean"}},
                "required": ["reuse"], "additionalProperties": False}


def embed(questions: list[str]) -> np.ndarray:
    from fastembed import TextEmbedding  # imported here so --help works without it

    vectors = np.array(list(TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2").embed(questions)))
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)  # unit length: a dot product is the cosine


def answer(client, model: str, question: str) -> tuple[str, float]:
    resp = create(client, model=model, max_tokens=1024, system=SYSTEM, cache_control={"type": "ephemeral"},
                  output_config={"effort": "low"}, messages=[{"role": "user", "content": question}])
    ensure_answered(resp)
    return text_of(resp).strip(), cost_usd(resp.usage, resp.model) or 0.0


def check(client, model: str, cached_question: str, cached_answer: str, question: str) -> tuple[bool, float]:
    content = (f"<earlier_question>{cached_question}</earlier_question>\n<cached_answer>{cached_answer}"
               f"</cached_answer>\n<new_question>{question}</new_question>")
    resp = create(client, model=model, max_tokens=1024, system=CHECK_SYSTEM,
                  output_config={"effort": "low", "format": {"type": "json_schema", "schema": CHECK_SCHEMA}},
                  messages=[{"role": "user", "content": content}])
    ensure_answered(resp)
    return json.loads(text_of(resp))["reuse"], cost_usd(resp.usage, resp.model) or 0.0


def replay(sims: np.ndarray, threshold: float, answer_cost: list[float] | None, checker=None, sure: float = 1.0):
    """Send the stream through one cache policy.

    Returns hits, wrong hits, model calls, the cost of answers, the cost of checks, and the wrong hits.
    """
    cached: list[int] = []  # indexes of the questions whose answers are in the cache
    hits = wrong = calls = 0
    answers = checks = 0.0
    mistakes = []
    for i, (_, label) in enumerate(STREAM):
        best = max(cached, key=lambda j: sims[i, j], default=None)
        reuse = best is not None and sims[i, best] >= threshold
        if reuse and checker and sims[i, best] < sure:
            reuse, check_cost = checker(best, i)
            checks += check_cost
            calls += 1
        if reuse:
            hits += 1
            if STREAM[best][1] != label:
                wrong += 1
                mistakes.append((i, best))
        else:
            calls += 1
            answers += answer_cost[i] if answer_cost else 0.0
            cached.append(i)
    return hits, wrong, calls, answers, checks, mistakes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--embed-only", action="store_true", help="show similarities and hits without calling Claude")
    parser.add_argument("--thresholds", type=float, nargs="+", default=[0.9, 0.8, 0.7, 0.6, 0.5])
    parser.add_argument("--check-from", type=float, default=0.5,
                        help="the verified policy considers a cached answer from this similarity up (default: 0.5)")
    parser.add_argument("--sure", type=float, default=0.95,
                        help="the verified policy reuses answers above this similarity without a check (default: 0.95)")
    parser.add_argument("--verbose", action="store_true",
                        help="print each question's nearest earlier question, and every wrong hit")
    model_argument(parser)
    args = parser.parse_args()

    questions = [q for q, _ in STREAM]
    vectors = embed(questions)
    sims = vectors @ vectors.T
    print(f"{len(STREAM)} questions, {len({label for _, label in STREAM})} different things asked.\n")

    if args.verbose or args.embed_only:
        print("Each question's nearest earlier question:")
        for i, (q, label) in enumerate(STREAM[1:], 1):
            j = max(range(i), key=lambda j: sims[i, j])
            mark = "same" if STREAM[j][1] == label else "DIFFERENT answer"
            print(f"  {sims[i, j]:.2f}  {q}\n        ~ {STREAM[j][0]}  ({mark})")
        print()

    if args.embed_only:
        print(f"{'policy':<16}{'hits':>6}{'wrong':>7}{'calls':>7}")
        print(f"{'no cache':<16}{0:>6}{0:>7}{len(STREAM):>7}")
        for t in args.thresholds:
            hits, wrong, calls, *_ = replay(sims, t, None)
            print(f"{f'threshold {t:.2f}':<16}{hits:>6}{wrong:>7}{calls:>7}")
        print("\nNothing was sent to Claude. Run without --embed-only for answers, the check and costs.")
        return

    client = make_client()
    print(f"Answering each question once with {args.model}, the handbook in a cached system prompt…")
    first = answer(client, args.model, questions[0])  # alone, so it writes the prompt cache the others read
    with ThreadPoolExecutor(max_workers=8) as pool:
        answers = [first] + list(pool.map(lambda q: answer(client, args.model, q), questions[1:]))
    texts = [a for a, _ in answers]
    costs = [c for _, c in answers]

    verdicts: dict[tuple[int, int], tuple[bool, float]] = {}

    def checker(j: int, i: int) -> tuple[bool, float]:
        if (j, i) not in verdicts:
            verdicts[(j, i)] = check(client, args.model, questions[j], texts[j], questions[i])
        return verdicts[(j, i)]

    policies = [("no cache", 1.01, None)] + [(f"threshold {t:.2f}", t, None) for t in args.thresholds]
    policies.append((f"verified {args.check_from:.2f}+", args.check_from, checker))
    baseline = sum(costs)
    rows = []
    print(f"\n{'policy':<18}{'hits':>6}{'wrong':>7}{'calls':>7}{'cost':>11}{'saved':>8}"
          f"{'saved if answers cost':>24}")
    print(f"{'':<57}{'×10':>8}{'×40':>8}")
    for name, threshold, chk in policies:
        hits, wrong, calls, answers_cost, checks_cost, mistakes = replay(sims, threshold, costs, chk, args.sure)
        rows.append((name, mistakes))
        saved = [1 - (answers_cost * k + checks_cost) / (baseline * k) for k in (1, 10, 40)]
        print(f"{name:<18}{hits:>6}{wrong:>7}{calls:>7}{f'${answers_cost + checks_cost:.5f}':>11}{saved[0]:>8.0%}"
              f"{saved[1]:>16.0%}{saved[2]:>8.0%}")
    print("hits: answers served from the cache. wrong: hits whose cached answer was to a different question. "
          "calls: Claude calls, checks included.")

    seen = set()
    for name, mistakes in rows:
        for i, j in mistakes:
            if (i, j) in seen or (len(seen) >= 4 and not args.verbose):
                continue
            seen.add((i, j))
            print(f"\nWrong hit ({name}, similarity {sims[i, j]:.2f}):\n  asked   {questions[i]}\n"
                  f"  matched {questions[j]}\n  served  {texts[j]}\n  right   {texts[i]}")
    if not args.verbose and sum(len(m) for _, m in rows) > len(seen):
        print("\n(More wrong hits at lower thresholds: run with --verbose to see them all.)")
    rejected = [(j, i) for (j, i), (ok, _) in verdicts.items() if not ok]
    if rejected:
        print("\nThe check refused these reuses:")
        for j, i in rejected:
            print(f"  {sims[i, j]:.2f}  {questions[i]}  ≁  {questions[j]}"
                  f"{'' if STREAM[i][1] != STREAM[j][1] else '  (a miss: same answer)'}")


if __name__ == "__main__":
    run(main)
