"""Measure time to first token, and watch prompt caching cut the cost of a conversation.

Companion to the Context & cost lab. A long, unchanging system prompt (the
company handbook) is sent on every turn. With automatic caching, the first call
writes it to the cache and later calls read it at a fraction of the price.

    python 04_caching_and_latency.py
    python 04_caching_and_latency.py --no-cache    # compare the cost without caching
"""
from __future__ import annotations

import argparse
import time

from common import cost_usd, describe_usage, ensure_answered, make_client, model_argument, run, stream
from data import HANDBOOK

QUESTIONS = [
    "How many days of annual leave do I get, and can I carry any over?",
    "I'm flying to New York for a five-hour meeting trip. What class can I book?",
    "I lost my laptop on the train. What should I do and how quickly?",
    "Summarise the three rules from our chat that I am most likely to forget.",
]
SYSTEM = ("You answer employee questions using only the handbook below. Be concise: two or three sentences.\n\n"
          + HANDBOOK)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-cache", action="store_true", help="turn prompt caching off")
    model_argument(parser)
    args = parser.parse_args()
    client = make_client()

    history: list[dict] = []
    total = 0.0
    for turn, question in enumerate(QUESTIONS, 1):
        history.append({"role": "user", "content": question})
        params = dict(model=args.model, max_tokens=16000, output_config={"effort": "low"},
                      system=SYSTEM, messages=history)
        if not args.no_cache:
            params["cache_control"] = {"type": "ephemeral"}  # cache up to the last cacheable block

        print(f"\n--- Turn {turn}: {question}")
        start = time.perf_counter()
        first_text = None
        with stream(client, **params) as s:
            for chunk in s.text_stream:
                if first_text is None:
                    first_text = time.perf_counter()
                print(chunk, end="", flush=True)
            final = s.get_final_message()
        end = time.perf_counter()
        ensure_answered(final)

        # Append the full content, not just the text, so the history stays append-only.
        history.append({"role": "assistant", "content": final.content})
        ttft = (first_text or end) - start
        total += cost_usd(final.usage, args.model) or 0
        print(f"\n[first text after {ttft:.2f}s · total {end - start:.2f}s · {describe_usage(final.usage, args.model)}]")

    print(f"\nEstimated cost of the conversation: ${total:.4f}"
          f"{'  (caching off)' if args.no_cache else ''}")
    print("Time to first text includes the model's thinking, which happens before visible output.")


if __name__ == "__main__":
    run(main)
