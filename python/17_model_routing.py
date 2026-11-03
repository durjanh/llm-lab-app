"""Model routing: send each task to the cheapest model that gets it right, and measure what that saves.

Companion to the Model routing calculator lab, which works the same sums from numbers you type in. This
script measures them. Twenty-five tasks with answers the code can check, six easy and nineteen hard, go
through five strategies:

  small only      Claude Haiku answers everything
  large only      Claude Opus answers everything
  router          Haiku first labels each task easy or hard (a cheap extra call); easy goes to Haiku, hard to Opus
  cascade, sure   Haiku answers first. The task goes up to Opus when Haiku says it is unsure, or when a check
                  in code rejects the answer
  cascade, agree  Haiku answers twice, independently. The task goes up when the two answers differ, or when
                  the check rejects them

The check knows nothing of the right answer: it tests what production code could test, such as the format,
or whether a puzzle's solution satisfies the puzzle's rules. Scoring uses the known answers.

Each strategy reports accuracy, cost, cost per correct answer, and how many tasks reached Opus. Every model
answers every task once (Haiku twice) and the strategies reuse those answers, so a run costs about ten cents.

Both models answer at low effort without extended thinking, as a cost-sensitive service would run them. A
router is only as good as its labels: a task that looks easy and is not (multiplying two nine-digit numbers,
say) goes to the small model and comes back wrong. A model's own confidence is a weak signal; two answers that
disagree are a stronger one, and a check that proves the answer is the strongest.

    python 17_model_routing.py
    python 17_model_routing.py --small claude-haiku-5-5 --large claude-sonnet-5-5
"""
from __future__ import annotations

import argparse
import json
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from decimal import Decimal
from typing import Callable

from common import PRICES, cost_usd, create, ensure_answered, make_client, run, text_of


def number(text: str) -> Decimal | None:
    """The first number in the text, exactly: a float would round an 18-digit answer and score it right."""
    found = re.search(r"-?\d[\d,]*(?:\.\d+)?", text)
    return Decimal(found.group().replace(",", "")) if found else None


def is_number(text: str) -> bool:
    return number(text) is not None


def equals_number(expected: float, places: int = 0) -> Callable[[str], bool]:
    want = round(Decimal(str(expected)), places)
    return lambda text: number(text) is not None and round(number(text), places) == want


def seating_ok(text: str) -> bool:
    order = re.sub(r"[^A-E]", "", text.upper())
    if sorted(order) != list("ABCDE"):
        return False
    seat = {person: i + 1 for i, person in enumerate(order)}
    return (seat["A"] not in (1, 5) and seat["B"] == seat["C"] + 1 and seat["D"] in (1, 5)
            and abs(seat["E"] - seat["A"]) == 1 and seat["C"] != 2)


def four_digit_ok(text: str) -> bool:
    digits = re.sub(r"\D", "", text)
    return (len(digits) == 4 and len(set(digits)) == 4 and sum(map(int, digits)) == 20
            and int(digits) % 7 == 0 and int(digits[0]) == 2 * int(digits[-1]))


def knights_ok(text: str) -> bool:
    """A: "C is a knave." B: "A and C are the same type." C: "Exactly one of us three is a knight." """
    letters = re.sub(r"[^KN]", "", text.upper().replace("KNIGHT", "K").replace("KNAVE", "N"))
    if len(letters) != 3:
        return False
    a, b, c = (x == "K" for x in letters)
    return (a == (not c)) and (b == (a == c)) and (c == (a + b + c == 1))


@dataclass
class Task:
    kind: str  # "easy" or "hard": what a person would say, not what the router decides
    prompt: str
    correct: Callable[[str], bool]  # knows the answer: used only to score
    check: Callable[[str], bool]  # what code could check in production, without the answer: used by the cascade


TASKS = [
    Task("easy", "Label the sentiment of this review as positive, negative or mixed: 'The screen is gorgeous but "
                 "the battery barely lasts a morning.'", lambda t: t.strip().lower() == "mixed",
         lambda t: t.strip().lower() in {"positive", "negative", "mixed"}),
    Task("easy", "Give the date in this sentence as YYYY-MM-DD: 'The audit is booked for Thursday 14 January 2027.'",
         lambda t: t.strip() == "2027-01-14", lambda t: bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", t.strip()))),
    Task("easy", "What is 48 × 25?", equals_number(1200), is_number),
    Task("easy", "How many minutes are there in 3.75 hours?", equals_number(225), is_number),
    Task("easy", "Sort these words alphabetically and give them comma-separated: pear, apple, fig, banana",
         lambda t: [w.strip().lower() for w in t.split(",")] == ["apple", "banana", "fig", "pear"],
         lambda t: sorted(w.strip().lower() for w in t.split(",")) == ["apple", "banana", "fig", "pear"]),
    Task("easy", "Give the email address in: 'Contact Ruth Okafor at ruth.okafor@fernhill.example or 01632 960 555.'",
         lambda t: t.strip().lower() == "ruth.okafor@fernhill.example",
         lambda t: bool(re.fullmatch(r"\S+@\S+\.\S+", t.strip()))),
    Task("hard", "How many times does the letter r appear in: 'The strawberry farmer's daughter carried raspberries'?",
         equals_number(11), is_number),
    Task("hard", "How many Friday the 13ths are there from 1 January 2027 to 31 December 2029 inclusive?",
         equals_number(4), is_number),
    Task("hard", "How many different ways can you make 50p from 1p, 2p, 5p, 10p, 20p and 50p coins, if the order "
                 "of the coins does not matter?", equals_number(451), is_number),
    Task("hard", "What date is 1,000 days after 29 February 2028? Give it as YYYY-MM-DD.",
         lambda t: t.strip() == "2030-11-25", lambda t: bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", t.strip()))),
    Task("hard", "Pipe A fills a tank in 6 hours and pipe B in 9 hours. A drain empties the full tank in 12 hours. "
                 "With all three open and the tank empty at the start, how many hours until it is full? Give the "
                 "number to two decimal places.", equals_number(36 / 7, 2), is_number),
    Task("hard", "Find a four-digit number whose digits are all different, whose digits add up to 20, which is "
                 "divisible by 7, and whose first digit is twice its last digit. Give one such number.",
         four_digit_ok, four_digit_ok),
    Task("hard", "Five people, A to E, sit in seats 1 to 5 in a row. A is not at either end. B sits immediately "
                 "to the right of C (in the next higher seat). D is in seat 1 or seat 5. E sits next to A. C is "
                 "not in seat 2. Give one seating order from seat 1 to seat 5 as five letters, such as ABCDE.",
         seating_ok, seating_ok),
    Task("hard", "On an island, knights always tell the truth and knaves always lie. A says: 'C is a knave.' "
                 "B says: 'A and C are the same type.' C says: 'Exactly one of us three is a knight.' Which is "
                 "each? Answer with three letters for A, B and C, K for knight and N for knave, such as KNK.",
         knights_ok, lambda t: len(re.sub(r"[^KN]", "", t.upper())) == 3),
    Task("hard", "What is 7,384 × 6,927? Give the exact number.", equals_number(51_148_968), is_number),
    Task("hard", "How many prime numbers are there between 1,000 and 1,100?", equals_number(16), is_number),
    Task("hard", "What is the sum of the digits of 2 to the power 50?", equals_number(76), is_number),
    Task("hard", "How many times does the letter e appear in: 'Seven sleepy sheep seemed especially eager to leave "
                 "the green meadow before evening'?", equals_number(23), is_number),
    Task("hard", "How many days are there from 3 March 2026 to 17 September 2031, counting the last day but not "
                 "the first?", equals_number(2024), is_number),
    Task("hard", "In how many distinct ways can the letters of MISSISSIPPI be arranged so that no two S are "
                 "next to each other?", equals_number(7350), is_number),
    Task("hard", "What is 987,654,321 × 123,456,789? Give the exact number.",
         equals_number(121_932_631_112_635_269), is_number),
    Task("hard", "How many whole numbers from 1 to 10,000 have digits that add up to 20?",
         equals_number(633), is_number),
    Task("hard", "What is the 25th prime number greater than 10,000?", equals_number(10223), is_number),
    Task("hard", "How many times does the letter p appear, upper or lower case, in: 'Peter Piper picked a peck of "
                 "pickled peppers, and the people who prepared the pepper pots kept a pretty purple pot of "
                 "preserved apples ready for the proper Sunday supper'?", equals_number(29), is_number),
    Task("hard", "What is the sum of the digits of 2 to the power 100?", equals_number(115), is_number),
]

ANSWER_SYSTEM = ("Answer the task. Put only the final answer in the answer field, with no working or units, and "
                 "set confident to false if you are not sure it is right.")
ANSWER_SCHEMA = {"type": "object", "properties": {"answer": {"type": "string"}, "confident": {"type": "boolean"}},
                 "required": ["answer", "confident"], "additionalProperties": False}
ROUTER_SYSTEM = ("You route tasks between a small, cheap model and a large, expensive one. Label a task easy "
                 "if it is a lookup, a single calculation, a format conversion or a classification. Label it "
                 "hard if it needs several steps of reasoning, careful counting, search through possibilities "
                 "or checking constraints. Do not solve it.")
ROUTER_SCHEMA = {"type": "object", "properties": {"route": {"type": "string", "enum": ["easy", "hard"]}},
                 "required": ["route"], "additionalProperties": False}


def ask(client, model: str, system: str, schema: dict, prompt: str) -> tuple[dict, float]:
    resp = create(client, model=model, max_tokens=2048, system=system,
                  output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
                  messages=[{"role": "user", "content": prompt}])
    ensure_answered(resp)
    return json.loads(text_of(resp)), cost_usd(resp.usage, resp.model) or 0.0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--small", default="claude-haiku-5-5", help="the cheap model (default: claude-haiku-5-5)")
    parser.add_argument("--large", default="claude-opus-5-5", help="the strong model (default: claude-opus-5-5)")
    args = parser.parse_args()
    client = make_client()

    jobs = ([(args.small, ANSWER_SYSTEM, ANSWER_SCHEMA, t.prompt) for t in TASKS] * 2
            + [(args.large, ANSWER_SYSTEM, ANSWER_SCHEMA, t.prompt) for t in TASKS]
            + [(args.small, ROUTER_SYSTEM, ROUTER_SCHEMA, f"<task>{t.prompt}</task>") for t in TASKS])
    print(f"Sending {len(TASKS)} tasks to {args.small} and {args.large}, and to {args.small} as the router…\n")
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda job: ask(client, *job), jobs))
    n = len(TASKS)
    small, small_again, large, routes = (results[i * n:(i + 1) * n] for i in range(4))

    strategies = ("small only", "large only", "router", "cascade, sure", "cascade, agree")
    totals = {name: {"right": 0, "cost": 0.0, "to_large": 0} for name in strategies}

    def score(name: str, task: Task, answer: str, cost: float, to_large: bool) -> str:
        ok = task.correct(answer)
        totals[name]["right"] += ok
        totals[name]["cost"] += cost
        totals[name]["to_large"] += to_large
        return "✓" if ok else "✗"

    def same(task: Task, a: str, b: str) -> bool:
        if task.check is task.correct:  # the check proves an answer, so two different valid answers both stand
            return task.check(a) and task.check(b)
        return re.sub(r"[\s,]", "", a.lower()) == re.sub(r"[\s,]", "", b.lower())

    print(f"{'task':<46}{'kind':<6}{'small':<14}{'again':<14}{'large':<14}{'router':<8}{'sure':<7}agree")
    rows = zip(TASKS, small, small_again, large, routes)
    for task, (s, s_cost), (s2, s2_cost), (l, l_cost), (r, r_cost) in rows:
        s_mark = score("small only", task, s["answer"], s_cost, False)
        l_mark = score("large only", task, l["answer"], l_cost, True)
        hard = r["route"] == "hard"
        score("router", task, l["answer"] if hard else s["answer"], r_cost + (l_cost if hard else s_cost), hard)
        up = not s["confident"] or not task.check(s["answer"])
        score("cascade, sure", task, l["answer"] if up else s["answer"], s_cost + (l_cost if up else 0), up)
        up2 = not task.check(s["answer"]) or not same(task, s["answer"], s2["answer"])
        score("cascade, agree", task, l["answer"] if up2 else s["answer"],
              s_cost + s2_cost + (l_cost if up2 else 0), up2)
        label = task.prompt if len(task.prompt) <= 44 else task.prompt[:43] + "…"
        again = "=" if same(task, s["answer"], s2["answer"]) else s2["answer"][:11]
        print(f"{label:<46}{task.kind:<6}{s_mark} {s['answer'][:11]:<12}{again:<14}{l_mark} {l['answer'][:11]:<12}"
              f"{r['route']:<8}{'large' if up else 'small':<7}{'large' if up2 else 'small'}")

    print(f"\n{'strategy':<16}{'right':>8}{'to large':>10}{'cost':>11}{'per right answer':>18}")
    for name, t in totals.items():
        per_right = f"${t['cost'] / t['right']:.5f}" if t["right"] else "-"
        print(f"{name:<16}{t['right']:>5}/{n:<2}{t['to_large']:>7}/{n:<2}{f'${t['cost']:.5f}':>11}{per_right:>18}")

    small_price, large_price = PRICES[args.small]["input"], PRICES[args.large]["input"]
    print(f"\n{args.large} costs {large_price / small_price:.0f}× {args.small} per input token. A strategy beats "
          "'large only' when it keeps most of the accuracy and sends few tasks up. The router's own call is "
          "small, but every wrong 'easy' label is a wrong answer. A cascade pays twice for every task it "
          "escalates, and misses any mistake its signal cannot see.")
    unsure = sum(not s["confident"] for s, _ in small)
    wrong = sum(not t.correct(s["answer"]) for t, (s, _) in zip(TASKS, small))
    print(f"\nOf its {n} answers, {args.small} marked {unsure} as unsure; {wrong} were wrong.")
    hard_as_easy = [t for t, (r, _) in zip(TASKS, routes) if t.kind == "hard" and r["route"] == "easy"]
    if hard_as_easy:
        print("\nThe router called these hard tasks easy:")
        for t in hard_as_easy:
            print(f"  - {t.prompt}")


if __name__ == "__main__":
    run(main)
