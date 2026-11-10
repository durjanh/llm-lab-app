"""A self-improving agent: it learns a house style from feedback, and keeps a lesson only if it helps.

The agent turns raw expense lines into records for a finance system. Nobody tells it the house style. A checker in
code knows it (ISO dates, supplier names in capitals without "Ltd" or "PLC", amounts as "GBP 1,234.50", no VAT on
rail fares or books) and reports which fields were wrong and what they should have been.

Each round, Reflexion-style:
1. The agent formats a training batch, reading the lessons it has so far.
2. The checker marks it.
3. Claude reads the failures and proposes up to three short lessons.
4. The safeguard: each lesson is tried on a separate validation batch, and kept only if the score goes up. A lesson
   that changes nothing is refused too, because every later call pays for it. Without this, a confident wrong lesson
   would be kept and every later answer would drift. Round 1 also plants one bad lesson, so you can watch the gate.
   The gate is only as good as the validation batch: six lines is small, so luck can still let a weak lesson in.

Lessons are saved in generated/agent-lessons/lessons.json, so the next run starts where this one stopped. At the end a
test batch the agent never trained on is scored with no lessons and with the kept ones.

    python 23_self_improving_agent.py                 # 3 rounds, then the test
    python 23_self_improving_agent.py                 # again: it starts from the saved lessons
    python 23_self_improving_agent.py --rounds 1 --no-plant
    python 23_self_improving_agent.py --reset         # forget every lesson
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Callable

from common import create, cost_usd, ensure_answered, make_client, model_argument, run, text_of

REPO = Path(__file__).resolve().parent.parent
LESSONS_FILE = REPO / "generated" / "agent-lessons" / "lessons.json"
MAX_LESSONS = 8  # a cap, so the lesson list cannot grow into junk that every call pays for
PLANTED = "Write amounts as whole pounds with no currency, for example 1235."
LEGAL_SUFFIXES = ("LIMITED", "LTD", "PLC", "LLP", "INC", "GMBH")
ZERO_RATED = ("rail fare", "book")
VAT_RATE = Decimal("0.20")
FIELDS = ("date", "supplier", "net", "vat", "gross")


@dataclass(frozen=True)
class Line:
    id: str
    iso: str  # the real date
    raw_date: str
    supplier: str
    what: str
    amount: str  # as written on the receipt
    basis: str  # "inc VAT" or "ex VAT"

    @property
    def raw(self) -> str:
        return f"{self.raw_date} | {self.supplier} | {self.what} | {self.amount} {self.basis}"


def L(n, iso, raw_date, supplier, what, amount, basis="inc VAT") -> Line:
    return Line(f"E{n:02}", iso, raw_date, supplier, what, amount, basis)


# Invented receipts. Inc-VAT amounts are multiples of 1.20, so the net comes out to the penny.
TRAIN = [
    L(1, "2026-11-03", "03/11/26", "Greenway Rail Ltd", "rail fare Reading-Paddington", "£48.60"),
    L(2, "2026-11-04", "4 Nov 2026", "Cloudhaven Hosting Limited", "server hosting, November", "1234.80"),
    L(3, "2026-11-05", "2026.11.05", "paper & ink ltd", "printer toner", "£85", "ex VAT"),
    L(4, "2026-11-06", "6th November 2026", "Brightline Books PLC", "book: Warehouse Design", "£32.50"),
    L(5, "2026-11-07", "07-11-2026", "Northgate Catering LLP", "team lunch", "£216.00"),
    L(6, "2026-11-10", "10/11/26", "Datawell Software Inc", "analytics licence", "1,450", "ex VAT"),
]
VALIDATION = [
    L(7, "2026-10-28", "28/10/26", "Westfield Taxis Ltd", "taxi to client", "£36.00"),
    L(8, "2026-10-29", "29 Oct 2026", "Coastline Rail Limited", "rail fare Bristol-Swindon", "£64.20"),
    L(9, "2026-10-30", "2026.10.30", "Officemart plc", "desk chairs", "2,400", "ex VAT"),
    L(10, "2026-11-01", "1st November 2026", "Readwell Books Ltd", "book: Lean Logistics", "£24.99"),
    L(11, "2026-11-02", "02-11-2026", "Pixelforge GmbH", "design software", "£599.40"),
    L(12, "2026-11-11", "11/11/26", "Harbour Print Ltd", "brochures", "312.50", "ex VAT"),
]
TEST = [
    L(13, "2026-11-12", "12/11/26", "Greenway Rail Ltd", "rail fare Reading-Oxford", "£19.80"),
    L(14, "2026-11-13", "13 Nov 2026", "Cloudhaven Hosting Limited", "backup storage", "£96.00"),
    L(15, "2026-11-14", "2026.11.14", "Fieldstone Furniture LLP", "standing desk", "1,125", "ex VAT"),
    L(16, "2026-11-16", "16th November 2026", "Atlas Maps & Books Ltd", "book: Freight Atlas", "£45.00"),
    L(17, "2026-11-17", "17-11-2026", "Northgate Catering LLP", "client breakfast", "£144.60"),
    L(18, "2026-11-18", "18/11/26", "Vantage Analytics Inc", "dashboard licence", "2,075.50", "ex VAT"),
]

RECORDS_SCHEMA = {
    "type": "object",
    "properties": {"records": {"type": "array", "items": {
        "type": "object",
        "properties": {k: {"type": "string"} for k in ("id", *FIELDS)},
        "required": ["id", *FIELDS], "additionalProperties": False}}},
    "required": ["records"], "additionalProperties": False,
}
LESSONS_SCHEMA = {
    "type": "object",
    "properties": {"lessons": {"type": "array", "items": {"type": "string"}}},
    "required": ["lessons"], "additionalProperties": False,
}


# --- The hidden checker -------------------------------------------------------------------------------------------

def money(value: Decimal) -> str:
    return f"GBP {value:,.2f}"


def canonical_supplier(name: str) -> str:
    words = name.upper().replace(".", "").replace(",", "").split()
    while words and words[-1] in LEGAL_SUFFIXES:
        words.pop()
    return " ".join(words)


def expected(line: Line) -> dict[str, str]:
    """The record the finance system wants for this line."""
    amount = Decimal(line.amount.replace("£", "").replace(",", ""))
    pence = Decimal("0.01")
    if any(word in line.what.lower() for word in ZERO_RATED):
        net, vat = amount, Decimal(0)
    elif line.basis == "ex VAT":
        net, vat = amount, (amount * VAT_RATE).quantize(pence, ROUND_HALF_UP)
    else:
        net = (amount / (1 + VAT_RATE)).quantize(pence, ROUND_HALF_UP)
        vat = amount - net
    return {"date": line.iso, "supplier": canonical_supplier(line.supplier),
            "net": money(net), "vat": money(vat), "gross": money(net + vat)}


def grade(lines: list[Line], records: list[dict]) -> tuple[int, int, list[dict]]:
    """Checks passed, checks made, and one entry per line that failed something (with what was expected)."""
    by_id = {r.get("id"): r for r in records}
    passed, failures = 0, []
    for line in lines:
        want, got = expected(line), by_id.get(line.id, {})
        wrong = {f: {"got": got.get(f), "expected": want[f]} for f in FIELDS if str(got.get(f, "")).strip() != want[f]}
        passed += len(FIELDS) - len(wrong)
        if wrong:
            failures.append({"line": line.raw, "wrong": wrong})
    return passed, len(lines) * len(FIELDS), failures


# --- The safeguard -------------------------------------------------------------------------------------------------

def gate(current: list[str], candidates: list[str], evaluate: Callable[[list[str]], float],
         baseline: float) -> tuple[list[str], list[tuple[str, float, str]], float]:
    """Try each candidate on the validation batch. Keep it only if the score rises.

    Returns the kept lessons, the rejected ones with their score and reason, and the validation score at the end.
    """
    kept, rejected, best = [], [], baseline
    for lesson in candidates:
        lesson = lesson.strip()
        if not lesson or lesson in current or lesson in kept:
            rejected.append((lesson, best, "duplicate"))
            continue
        if len(current) + len(kept) >= MAX_LESSONS:
            rejected.append((lesson, best, f"the list is full ({MAX_LESSONS})"))
            continue
        score = evaluate(current + kept + [lesson])
        if score > best:
            kept.append(lesson)
            best = score
        elif score == best:
            rejected.append((lesson, score, f"no gain: validation stayed at {score:.0%}"))
        else:
            rejected.append((lesson, score, f"validation fell from {best:.0%} to {score:.0%}"))
    return kept, rejected, best


# --- The agent -----------------------------------------------------------------------------------------------------

class Agent:
    def __init__(self, client, model: str):
        self.client, self.model, self.spent, self.calls = client, model, 0.0, 0

    def _call(self, system: str, prompt: str, schema: dict) -> dict:
        response = create(self.client, model=self.model, max_tokens=8000, system=system,
                          messages=[{"role": "user", "content": prompt}],
                          output_config={"format": {"type": "json_schema", "schema": schema}})
        self.spent += cost_usd(response.usage, self.model) or 0
        self.calls += 1
        ensure_answered(response)
        return json.loads(text_of(response))

    def attempt(self, lines: list[Line], lessons: list[str]) -> list[dict]:
        rules = "".join(f"- {lesson}\n" for lesson in lessons)
        prompt = (f"House style lessons learned from earlier feedback:\n{rules}\n" if lessons else "")
        prompt += "Lines:\n" + "\n".join(f"{line.id}: {line.raw}" for line in lines)
        system = ("You turn raw expense lines into records for the finance system at Fernhill Logistics: date, "
                  "supplier, net, VAT and gross amounts. Return one record per line, with the line's id.")
        return self._call(system, prompt, RECORDS_SCHEMA)["records"]

    def score(self, lines: list[Line], lessons: list[str]) -> float:
        passed, total, _ = grade(lines, self.attempt(lines, lessons))
        return passed / total

    def reflect(self, failures: list[dict], lessons: list[str]) -> list[str]:
        current = "".join(f"- {lesson}\n" for lesson in lessons) or "(none yet)\n"
        prompt = (f"Current lessons:\n{current}\nFailures from the last batch, with what the checker expected:\n"
                  f"{json.dumps(failures, indent=1)}\n\nWrite at most 3 new lessons. Each is one sentence: a general "
                  "rule that explains several failures, not a fact about one line. Do not repeat a current lesson.")
        system = "You improve an expense-formatting agent by writing short lessons it will read next time."
        return self._call(system, prompt, LESSONS_SCHEMA)["lessons"][:3]


def load_lessons() -> dict:
    if LESSONS_FILE.exists():
        return json.loads(LESSONS_FILE.read_text())
    return {"lessons": [], "history": []}


def save_lessons(state: dict) -> None:
    LESSONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    LESSONS_FILE.write_text(json.dumps(state, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--no-plant", action="store_true", help="do not plant a bad lesson in round 1")
    parser.add_argument("--reset", action="store_true", help="delete the saved lessons and exit")
    model_argument(parser)
    args = parser.parse_args()
    if args.reset:
        LESSONS_FILE.unlink(missing_ok=True)
        print(f"Deleted {LESSONS_FILE.relative_to(REPO)}.")
        return

    state = load_lessons()
    lessons: list[str] = state["lessons"]
    print(f"Model: {args.model}")
    print(f"Starting with {len(lessons)} saved lesson(s) from {LESSONS_FILE.relative_to(REPO)}.")
    for lesson in lessons:
        print(f"  - {lesson}")
    agent = Agent(make_client(), args.model)
    table = []

    for round_no in range(1, args.rounds + 1):
        before = agent.spent
        print(f"\n=== Round {round_no} ===")
        passed, total, failures = grade(TRAIN, agent.attempt(TRAIN, lessons))
        train = passed / total
        print(f"Training batch: {passed}/{total} checks passed ({train:.0%}).")
        for failure in failures[:3]:
            print(f"  {failure['line']}\n    " + "; ".join(
                f"{f}: got {w['got']!r}, expected {w['expected']!r}" for f, w in failure["wrong"].items()))
        if len(failures) > 3:
            print(f"  ... and {len(failures) - 3} more line(s) with mistakes.")
        if not failures:
            print("Nothing to learn this round.")
            table.append((round_no, train, None, None, 0, 0, agent.spent - before))
            continue

        candidates = agent.reflect(failures, lessons)
        if round_no == 1 and not args.no_plant:
            candidates.append(PLANTED)
        print("Proposed lessons:")
        for c in candidates:
            print(f"  ? {c}" + ("   (planted, to test the gate)" if c == PLANTED else ""))

        baseline = agent.score(VALIDATION, lessons)
        print(f"Validation with the current lessons: {baseline:.0%}")
        kept, rejected, after = gate(lessons, candidates, lambda ls: agent.score(VALIDATION, ls), baseline)
        for lesson in kept:
            print(f"  kept:     {lesson}")
        for lesson, score, why in rejected:
            print(f"  rejected: {lesson}  ({why})")
        lessons = lessons + kept
        state["lessons"] = lessons
        state["history"].append({"at": datetime.now().isoformat(timespec="seconds"), "round": round_no,
                                 "train": train, "validation": [baseline, after], "kept": kept,
                                 "rejected": [r[0] for r in rejected]})
        save_lessons(state)
        table.append((round_no, train, baseline, after, len(kept), len(rejected), agent.spent - before))

    print("\nRound  Train  Val before  Val after  Kept  Rejected  Cost")
    for r, train, vb, va, k, rej, cost in table:
        fmt = lambda v: f"{v:.0%}" if v is not None else "-"  # noqa: E731
        print(f"{r:>5}  {train:>5.0%}  {fmt(vb):>10}  {fmt(va):>9}  {k:>4}  {rej:>8}  ${cost:.4f}")

    print("\n=== Test batch (never used for learning) ===")
    without = agent.score(TEST, [])
    with_lessons = agent.score(TEST, lessons)
    print(f"No lessons:            {without:.0%}")
    print(f"With {len(lessons)} kept lesson(s): {with_lessons:.0%}")
    print(f"\nEstimated cost: ${agent.spent:.4f} over {agent.calls} API calls. Lessons saved for the next run.")


if __name__ == "__main__":
    run(main)
