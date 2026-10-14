"""Grade free-text answers with Claude as a judge, and check the judge itself.

Companion to the Evals lab. A rubric judge scores candidate answers to handbook
questions. Because a judge is a model too, the script measures how often it
agrees with human labels, and runs a pairwise test in both orders to expose
position bias.

    python 08_eval_with_judge.py
    python 08_eval_with_judge.py --skip-pairwise
"""
from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor

from common import proportion_ci, cost_usd, create, ensure_answered, make_client, model_argument, run, text_of
from data import HANDBOOK

# question, candidate answer, human verdict (True = acceptable)
CASES = [
    ("How many days of annual leave do full-time staff get?",
     "25 days a year plus public holidays, and up to 5 unused days carry over.", True),
    ("How many days of annual leave do full-time staff get?",
     "30 days a year, plus public holidays.", False),
    ("Can I expense a taxi to the airport at 5am?",
     "Yes. Taxis are covered between 10pm and 6am, so a 5am taxi qualifies. Keep the receipt.", True),
    ("Can I expense a taxi to the airport at 5am?",
     "Taxis are never reimbursed, so take the train.", False),
    ("What should I do if I lose my laptop?",
     "Call the IT service desk on extension 4400 within 24 hours.", True),
    ("What should I do if I lose my laptop?",
     "Report it to IT. You will also need to pay a £200 replacement fee and file a police report within a week, "
     "and your manager must sign a loss form before you get a new one.", False),
    ("How often are performance reviews?",
     "Twice a year, in April and October.", True),
    ("How much does the company pay into my pension?",
     "6% of salary if you pay at least 4%.", True),
]

RUBRIC = """Judge the candidate answer against the handbook. Criteria:
- correct: every fact in the answer agrees with the handbook.
- complete: it answers the question that was asked.
- concise: three sentences or fewer.
- grounded: it adds no rules, numbers or steps that are not in the handbook."""

SCHEMA = {
    "type": "object",
    "properties": {
        "correct": {"type": "boolean"}, "complete": {"type": "boolean"},
        "concise": {"type": "boolean"}, "grounded": {"type": "boolean"},
        "reason": {"type": "string"},
    },
    "required": ["correct", "complete", "concise", "grounded", "reason"],
    "additionalProperties": False,
}
PAIR_SCHEMA = {
    "type": "object",
    "properties": {"better": {"type": "string", "enum": ["A", "B"]}},
    "required": ["better"],
    "additionalProperties": False,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-pairwise", action="store_true")
    model_argument(parser)
    args = parser.parse_args()
    client = make_client()
    # The rubric and handbook are the same on every call, so mark the end of that shared
    # block as a cache breakpoint. Only the short question and answer change per call.
    system = [{"type": "text", "text": f"You are a strict grader.\n\n{RUBRIC}\n\n<handbook>\n{HANDBOOK}\n</handbook>",
               "cache_control": {"type": "ephemeral"}}]
    spend = 0.0

    def judge(case):
        question, answer, _ = case
        resp = create(client, model=args.model, max_tokens=4096, system=system,
                      output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
                      messages=[{"role": "user", "content": f"<question>{question}</question>\n<answer>{answer}</answer>"}])
        ensure_answered(resp)
        return json.loads(text_of(resp)), resp.usage

    # A cache entry is readable only once the first response has started, so grade one
    # case first and the rest in parallel; parallel first calls would all pay full price.
    verdicts = [judge(CASES[0])]
    with ThreadPoolExecutor(max_workers=4) as pool:
        verdicts += list(pool.map(judge, CASES[1:]))

    agree = []
    for (question, answer, human), (v, usage) in zip(CASES, verdicts):
        spend += cost_usd(usage, args.model) or 0
        judged = all(v[k] for k in ("correct", "complete", "concise", "grounded"))
        agree.append(judged == human)
        failed = [k for k in ("correct", "complete", "concise", "grounded") if not v[k]]
        print(f"{'agree   ' if judged == human else 'DISAGREE'} human={'pass' if human else 'fail'} "
              f"judge={'pass' if judged else 'fail'} {'(failed: ' + ', '.join(failed) + ')' if failed else ''}")
        print(f"         {answer[:90]}")
    low, high = proportion_ci(sum(agree), len(agree))
    print(f"\nJudge agrees with human labels on {sum(agree)}/{len(agree)} cases (95% interval {low:.0%} to {high:.0%}).")
    print("Check a judge like this before you trust its scores on thousands of outputs.")

    if not args.skip_pairwise:
        print("\nPosition bias test: the same pair judged in both orders")
        pairs = [(CASES[0], CASES[1]), (CASES[2], CASES[3]), (CASES[4], CASES[5])]
        flips = 0
        for good, bad in pairs:
            picks = []
            for first, second in ((good, bad), (bad, good)):
                resp = create(client, model=args.model, max_tokens=4096, system=system,
                              output_config={"effort": "low", "format": {"type": "json_schema", "schema": PAIR_SCHEMA}},
                              messages=[{"role": "user", "content":
                                         f"<question>{good[0]}</question>\n<answer_A>{first[1]}</answer_A>\n"
                                         f"<answer_B>{second[1]}</answer_B>\nWhich answer is better?"}])
                ensure_answered(resp)
                spend += cost_usd(resp.usage, args.model) or 0
                choice = json.loads(text_of(resp))["better"]
                picks.append(first if choice == "A" else second)
            consistent = picks[0] is picks[1]
            flips += not consistent
            print(f"  {good[0][:50]:<52} {'consistent' if consistent else 'FLIPPED with order'}")
        print(f"  {flips} of {len(pairs)} pairs changed verdict when the order was swapped.")

    print(f"\nEstimated cost: ${spend:.4f}")


if __name__ == "__main__":
    run(main)
