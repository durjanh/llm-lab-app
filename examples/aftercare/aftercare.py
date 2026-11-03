"""Aftercare with Claude: post-discharge follow-up calls, with our own tool loop (ward.claude_turn).

    python aftercare.py chat                      # you are Margaret Bell; every tool call is shown
    python aftercare.py chat --patient P103       # Lucía Fernández, in Spanish
    python aftercare.py test                      # eight simulated patients, checked on what the record holds
    python aftercare.py test --patients P105 P107 --model claude-sonnet-5-5
    python aftercare.py queue                     # the care team's open tasks

The same records, rules and tools run on Microsoft Agent Framework in aftercare_af.py, and on the lab's
/aftercare page. Reads ANTHROPIC_API_KEY from the environment or the lab's .env.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import anthropic
from dotenv import load_dotenv

import ward

HERE = Path(__file__).parent
DATABASE = HERE / "data" / "aftercare.db"
TEST_DATABASE = HERE / "data" / "test.db"
MODEL = "claude-haiku-5-5"
PATIENT_MODEL = "claude-haiku-5-5"  # the simulated patient is not what is being tested


class Usage:
    """Tokens across a run. Prices live in the lab's python/common.py; the page shows dollars."""

    def __init__(self) -> None:
        self.input = self.cached = self.output = 0

    def add(self, response) -> None:
        u = response.usage
        self.input += u.input_tokens + (u.cache_creation_input_tokens or 0)
        self.cached += u.cache_read_input_tokens or 0
        self.output += u.output_tokens

    def __str__(self) -> str:
        return f"{self.input:,} input, {self.cached:,} read from cache, {self.output:,} output tokens"


def print_steps(steps: list[dict]) -> None:
    for s in steps:
        print(f"   · {s['tool']}({json.dumps(s['args'], ensure_ascii=False)[:120]}) -> "
              f"{json.dumps(s['result'], ensure_ascii=False)[:160]}")


def chat(args, client: anthropic.Anthropic) -> None:
    if not DATABASE.exists():
        ward.create_database(DATABASE)
    call = ward.Call(DATABASE, args.patient)
    usage = Usage()
    turn = lambda text: ward.claude_turn(client.messages.create, call, args.model, text, on_response=usage.add)
    reply, steps = turn(call.opening_note())
    print(f"Aftercare follow-up, wave {call.wave}, for {call.patient['name']} by {call.patient['channel']}. "
          "Empty line to stop.\n")
    print_steps(steps)
    print(f"Agent: {call.agent_output(reply)}\n")
    while not call.done and (text := input("You: ").strip()):
        reply, steps = turn(call.patient_input(text))
        print_steps(steps)
        print(f"\nAgent: {call.agent_output(reply)}\n")
    print(f"Record: {ward.record(DATABASE, args.patient)['outreach'][0]['status']}. {usage}.")


def test(args, client: anthropic.Anthropic) -> None:
    ward.create_database(TEST_DATABASE)
    usage, passed, total = Usage(), 0, 0
    for pid in args.patients:
        call = ward.Call(TEST_DATABASE, pid)
        print(f"\n=== {pid} {call.patient['name']}: wave {call.wave}, {call.patient['channel']}, "
              f"{ward.LANGUAGES[call.language]} ===")
        agent = lambda text: ward.claude_turn(client.messages.create, call, args.model, text, on_response=usage.add)
        patient = lambda c: ward.simulate_patient(client.messages.create, c, PATIENT_MODEL, on_response=usage.add)

        def show(e: dict) -> None:
            print_steps(e.get("steps", []))
            print(f"{'Agent' if e['speaker'] == 'agent' else 'Patient'}: {e['text']}")

        checks = ward.play(call, agent, patient, on_event=show)
        for c in checks:
            print(f"{'PASS' if c['passed'] else 'FAIL'}: {c['check']}")
        passed += sum(c["passed"] for c in checks)
        total += len(checks)
    print(f"\n{passed} of {total} checks passed with {args.model}. {usage}. Replies vary: run it more than once.")


def show_queue(args, client) -> None:
    for t in ward.queue(DATABASE):
        print(f"[{t['urgency']:>9}] {t['queue']:<14} {t['name']}: {t['reason']}")


def main() -> None:
    load_dotenv(HERE.parent.parent / ".env")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["chat", "test", "queue", "reset"])
    parser.add_argument("--patient", default="P101", choices=list(ward.BY_ID))
    parser.add_argument("--patients", nargs="+", default=list(ward.PERSONAS), choices=list(ward.PERSONAS))
    parser.add_argument("--model", default=MODEL)
    args = parser.parse_args()
    if args.command == "reset":
        ward.create_database(DATABASE)
        return print("A fresh hospital record.")
    {"chat": chat, "test": test, "queue": show_queue}[args.command](args, anthropic.Anthropic())


if __name__ == "__main__":
    main()
