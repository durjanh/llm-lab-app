"""An evaluation gate for a release pipeline: score a small labelled set with an LLM judge, fail below thresholds.

    python eval_gate.py --endpoint https://<resource>.cognitiveservices.azure.com --deployment gpt-5.4-mini

Signs in with azure-identity (the pipeline's OpenID Connect login, or az login locally). Exits 1 when a mean
score is under its threshold, which stops the pipeline before promotion. The lab's /foundry-operations page runs
the same idea with more evaluators.
"""
from __future__ import annotations

import argparse
import json
import sys

import httpx
from azure.identity import DefaultAzureCredential

CASES = [  # context, question, the response the release would give
    ("The excess for escape of water claims is £350.", "What is the excess for escape of water?", "It is £350."),
    ("Tell us about a claim within 30 days of the damage.", "How soon must I report a claim?", "Within 30 days."),
    ("We do not cover water that escapes gradually over time.", "Is a slow drip covered?", "No, gradual leaks are not covered."),
]
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["groundedness", "relevance"],
          "properties": {"groundedness": {"type": "integer"}, "relevance": {"type": "integer"}}}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--endpoint", required=True)
    p.add_argument("--deployment", default="gpt-5.4-mini")
    p.add_argument("--min-groundedness", type=float, default=4.0)
    p.add_argument("--min-relevance", type=float, default=4.0)
    a = p.parse_args()
    token = DefaultAzureCredential().get_token("https://cognitiveservices.azure.com/.default").token
    scores = []
    for context, question, response in CASES:
        r = httpx.post(f"{a.endpoint.rstrip('/')}/openai/v1/chat/completions", timeout=60,
                       headers={"Authorization": f"Bearer {token}"},
                       json={"model": a.deployment, "max_completion_tokens": 100,
                             "messages": [{"role": "user", "content": f"Score 1 to 5 using only the context.\nContext: {context}\n"
                                                                      f"Question: {question}\nResponse: {response}"}],
                             "response_format": {"type": "json_schema", "json_schema": {"name": "s", "schema": SCHEMA, "strict": True}}})
        r.raise_for_status()
        scores.append(json.loads(r.json()["choices"][0]["message"]["content"]))
    g = sum(s["groundedness"] for s in scores) / len(scores)
    rel = sum(s["relevance"] for s in scores) / len(scores)
    print(f"groundedness {g:.2f} (min {a.min_groundedness}), relevance {rel:.2f} (min {a.min_relevance})")
    sys.exit(0 if g >= a.min_groundedness and rel >= a.min_relevance else 1)


if __name__ == "__main__":
    main()
