"""The Message Batches API: send work that can wait, at half the price, outside your normal rate limits.

Companion to the Rate limits lab. The same review classification as 03_classify_reviews.py, sent as one
batch instead of a request per review. Anthropic processes it asynchronously, usually within an hour and
always within 24, and bills every token at 50% of the standard price. Batches have their own rate limits,
so a nightly job sent this way does not take capacity from the people using your app.

Results come back in any order, so each request carries a custom_id and the results are matched on it.

    python 14_batch_api.py --dry-run          # show the requests; send nothing
    python 14_batch_api.py                    # submit, wait, print results
    python 14_batch_api.py --no-wait          # submit and exit; collect later with --resume
    python 14_batch_api.py --resume msgbatch_...
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

from common import cost_usd, make_client, model_argument, proportion_ci, run, text_of
from data import REVIEWS

LABELS = ["positive", "negative", "mixed"]
SCHEMA = {
    "type": "object",
    "properties": {"sentiment": {"type": "string", "enum": LABELS}},
    "required": ["sentiment"],
    "additionalProperties": False,
}
SYSTEM = "Classify the sentiment of the customer review inside the review tags as positive, negative or mixed."
BATCH_DISCOUNT = 0.5  # every token in a batch is billed at half the standard price


def build_requests(model: str) -> list[Request]:
    return [
        Request(
            custom_id=f"review-{i}",
            params=MessageCreateParamsNonStreaming(
                model=model,
                max_tokens=1024,  # thinking counts towards max_tokens; low effort keeps it short
                system=SYSTEM,
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
                messages=[{"role": "user", "content": f"<review>{review}</review>"}],
            ),
        )
        for i, (review, _) in enumerate(REVIEWS)
    ]


def wait_for(client, batch_id: str, poll_s: float):
    """Polls until the batch has ended. Ctrl+C stops waiting, not the batch: it keeps running at Anthropic."""
    try:
        while True:
            batch = client.messages.batches.retrieve(batch_id)
            counts = batch.request_counts
            print(f"  {batch.processing_status}: {counts.processing} processing, {counts.succeeded} succeeded, "
                  f"{counts.errored} errored", flush=True)
            if batch.processing_status == "ended":
                return batch
            time.sleep(poll_s)
    except KeyboardInterrupt:
        print(f"\nStopped waiting. The batch carries on; collect it with:\n  python 14_batch_api.py --resume {batch_id}",
              file=sys.stderr)
        sys.exit(130)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="print the requests and send nothing")
    parser.add_argument("--no-wait", action="store_true", help="submit the batch and exit")
    parser.add_argument("--resume", metavar="BATCH_ID", help="wait for and collect a batch submitted earlier")
    parser.add_argument("--poll", type=float, default=15.0, help="seconds between status checks (default: 15)")
    model_argument(parser)
    args = parser.parse_args()
    requests = build_requests(args.model)

    if args.dry_run:
        print(f"{len(requests)} requests, one per review. The first:\n")
        print(json.dumps(requests[0], indent=2))
        print("\nNothing was sent.")
        return

    client = make_client()
    if args.resume:
        batch_id = args.resume
    else:
        batch = client.messages.batches.create(requests=requests)
        batch_id = batch.id
        print(f"Submitted batch {batch_id} with {len(requests)} requests. It expires {batch.expires_at:%Y-%m-%d %H:%M} UTC.")
        if args.no_wait:
            print(f"Collect the results later with:\n  python 14_batch_api.py --resume {batch_id}")
            return
    print("Waiting for it to end. Most batches finish within an hour; Ctrl+C stops waiting, not the batch.")
    wait_for(client, batch_id, args.poll)

    expected = {f"review-{i}": (review, label) for i, (review, label) in enumerate(REVIEWS)}
    predicted: dict[str, str] = {}
    standard_cost = 0.0
    for result in client.messages.batches.results(batch_id):  # in any order: match on custom_id
        outcome = result.result
        if outcome.type == "succeeded":
            message = outcome.message
            standard_cost += cost_usd(message.usage, message.model) or 0
            if message.stop_reason == "refusal":
                predicted[result.custom_id] = "(declined)"
            else:
                predicted[result.custom_id] = json.loads(text_of(message))["sentiment"]
        elif outcome.type == "errored":
            # invalid_request_error: fix the request before resending. Anything else is worth resubmitting as is.
            predicted[result.custom_id] = f"(error: {outcome.error.error.type})"
        else:  # canceled or expired: resubmit
            predicted[result.custom_id] = f"({outcome.type})"

    correct = 0
    for custom_id, (review, label) in expected.items():
        got = predicted.get(custom_id, "(missing)")
        correct += got == label
        print(f"{'✓' if got == label else '✗'} {got:<9} expected {label:<9} {review}")
    low, high = proportion_ci(correct, len(expected))
    print(f"\nAccuracy: {correct}/{len(expected)} = {correct / len(expected):.0%}   95% interval {low:.0%} to {high:.0%}")
    print(f"Estimated cost: ${standard_cost * BATCH_DISCOUNT:.4f} as a batch, against ${standard_cost:.4f} "
          "for the same requests sent one by one.")


if __name__ == "__main__":
    run(main)
