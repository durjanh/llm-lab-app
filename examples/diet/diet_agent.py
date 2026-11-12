"""Chat with the diet planner in the terminal: the same targets, checks, tools, memory and files as the /diet page.

    python examples/diet/diet_agent.py                          # you are the person; your name picks the memory folder
    python examples/diet/diet_agent.py --user sam --consent     # remember health details too (allergies, weight...)
    python examples/diet/diet_agent.py --model gpt-5.4-mini     # a GPT deployment, or the local model's id
    python examples/diet/diet_agent.py --forget --user sam      # delete what is remembered about sam

Type as the person. /files writes the plan as a PDF, a shopping list PDF and a spreadsheet to generated/diet/<user>/,
/plan prints the week, /memory prints the memory folder, /quit ends. Memory is kept in generated/diet-memory/<user>/,
the same folder the page uses. Every tool call is printed.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path[:0] = [str(REPO / "python"), str(HERE)]

import settings  # noqa: E402,F401  (loads .env before the client is made)
from common import CLAUDE_MODEL, cost_usd, create, make_client, run  # noqa: E402

import diet as rules  # noqa: E402

MEMORY_ROOT = REPO / "generated" / "diet-memory"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--user", default="guest", help="your name: it picks the memory folder")
    parser.add_argument("--consent", action="store_true", help="let the agent remember health details")
    parser.add_argument("--model", default=CLAUDE_MODEL, help=f"model id (default: {CLAUDE_MODEL})")
    parser.add_argument("--forget", action="store_true", help="delete the memory folder and stop")
    args = parser.parse_args()
    chat = rules.new_chat(MEMORY_ROOT, args.user, args.consent)
    if args.forget:
        shutil.rmtree(MEMORY_ROOT / chat.user, ignore_errors=True)
        print(f"Forgot {chat.user}.")
        return
    client, total = make_client(), 0.0

    def charge(response) -> None:
        nonlocal total
        total += cost_usd(response.usage, args.model) or 0

    print(f"Diet planner on {args.model}, for {chat.user}. Health details "
          f"{'may' if args.consent else 'may not'} be remembered. /files /plan /memory /quit\n")
    while True:
        try:
            text = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not text:
            continue
        if text == "/quit":
            break
        if text == "/memory":
            for f in sorted((MEMORY_ROOT / chat.user).rglob("*")) if (MEMORY_ROOT / chat.user).exists() else []:
                if f.is_file():
                    print(f"--- {f.name} ---\n{f.read_text().rstrip()}")
            continue
        if text in ("/plan", "/files"):
            if not chat.plan:
                print("  No plan yet.")
                continue
            if text == "/plan":
                for day, t in rules.daily_totals(chat.plan).items():
                    meals = next(d["meals"] for d in chat.plan["days"] if d["day"] == day)
                    print(f"  {day}: {t['kcal']} kcal, {t['protein_g']} g protein · " + " | ".join(m["name"] for m in meals))
                continue
            out = REPO / "generated" / "diet" / chat.user
            out.mkdir(parents=True, exist_ok=True)
            for name, _, make in rules.FILES.values():
                (out / name).write_bytes(make(chat))
                print(f"  wrote {(out / name).relative_to(REPO)}")
            continue
        reply, steps = rules.diet_turn(lambda **p: create(client, **p), chat, args.model, text, on_response=charge)
        for s in steps:
            print(f"  tool {s['tool']}({json.dumps(s['args'])[:160]}) -> {json.dumps(s['result'])[:240]}")
        print(f"\nPlanner: {reply}\n")
    print(f"Estimated cost: ${total:.4f}")


if __name__ == "__main__":
    run(main)
