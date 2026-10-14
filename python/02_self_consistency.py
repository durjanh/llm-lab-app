"""Self-consistency: ask the same question several times and take the majority answer.

Companion to the Sampling lab. Current Claude models do not accept a temperature
setting, but their answers still vary between calls, so independent samples can
be compared and voted on. Strong models often agree every time on easy questions;
the technique pays off on hard ones.

    python 02_self_consistency.py
    python 02_self_consistency.py --samples 7 --question "How many weekdays are there in March 2027?"
"""
from __future__ import annotations

import argparse
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from common import cost_usd, create, ensure_answered, make_client, model_argument, run, text_of

DEFAULT_QUESTION = ("A bat and a ball cost £1.10 in total. The bat costs £1.00 more than the ball. "
                    "How much does the ball cost?")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--question", default=DEFAULT_QUESTION)
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--effort", default="low", choices=["low", "medium", "high", "xhigh", "max"])
    model_argument(parser)
    args = parser.parse_args()
    client = make_client()

    prompt = f"{args.question}\n\nThink it through, then finish with a final line of the form 'Answer: <answer>'."

    def ask(_: int):
        resp = create(client, model=args.model, max_tokens=16000, output_config={"effort": args.effort},
                      messages=[{"role": "user", "content": prompt}])
        ensure_answered(resp)
        match = re.findall(r"Answer:\s*(.+)", text_of(resp))
        answer = match[-1].strip().rstrip(".") if match else "(no final answer line)"
        return answer, resp.usage

    with ThreadPoolExecutor(max_workers=min(args.samples, 5)) as pool:
        results = list(pool.map(ask, range(args.samples)))

    for i, (answer, usage) in enumerate(results, 1):
        print(f"Sample {i}: {answer}   ({usage.output_tokens:,} output tokens)")
    votes = Counter(answer for answer, _ in results)
    winner, count = votes.most_common(1)[0]
    total = sum(cost_usd(u, args.model) or 0 for _, u in results)
    print(f"\nMajority answer: {winner}  ({count} of {args.samples} samples agree)")
    print(f"Agreement is a usable confidence signal: {count / args.samples:.0%} here.")
    print(f"Estimated cost: ${total:.4f}")


if __name__ == "__main__":
    run(main)
