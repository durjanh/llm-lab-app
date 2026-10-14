"""Classify reviews with structured outputs and score the prompt like a tiny eval.

Companion to the Prompting and Evals labs. Structured outputs guarantee the reply
is valid JSON with one of the allowed labels, so the code never parses free text.

    python 03_classify_reviews.py
    python 03_classify_reviews.py --few-shot     # add examples to the system prompt
"""
from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor

from common import proportion_ci, cost_usd, create, ensure_answered, make_client, model_argument, run, text_of
from data import REVIEWS

LABELS = ["positive", "negative", "mixed"]
SCHEMA = {
    "type": "object",
    "properties": {"sentiment": {"type": "string", "enum": LABELS}},
    "required": ["sentiment"],
    "additionalProperties": False,
}
SYSTEM = "Classify the sentiment of the customer review inside the review tags as positive, negative or mixed."
EXAMPLES = """

Examples:
<review>Absolutely fantastic, I would go again.</review> -> positive
<review>The worst purchase I have ever made.</review> -> negative
<review>Great coffee, painfully slow service.</review> -> mixed"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--few-shot", action="store_true", help="include three labelled examples")
    model_argument(parser)
    args = parser.parse_args()
    client = make_client()
    system = SYSTEM + (EXAMPLES if args.few_shot else "")

    def classify(review: str):
        resp = create(client, model=args.model, max_tokens=4096, system=system,
                      output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
                      messages=[{"role": "user", "content": f"<review>{review}</review>"}])
        ensure_answered(resp)
        return json.loads(text_of(resp))["sentiment"], resp.usage

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(classify, [review for review, _ in REVIEWS]))

    outcomes = []
    for (review, expected), (predicted, _) in zip(REVIEWS, results):
        ok = predicted == expected
        outcomes.append(ok)
        print(f"{'✓' if ok else '✗'} {predicted:<9} expected {expected:<9} {review}")
    low, high = proportion_ci(sum(outcomes), len(outcomes))
    total = sum(cost_usd(u, args.model) or 0 for _, u in results)
    print(f"\nAccuracy: {sum(outcomes)}/{len(outcomes)} = {sum(outcomes) / len(outcomes):.0%}"
          f"   95% interval {low:.0%} to {high:.0%}")
    print("With only a dozen cases the interval is wide: one extra correct answer is not proof of a better prompt.")
    print(f"Estimated cost: ${total:.4f}")


if __name__ == "__main__":
    run(main)
