"""Chat with the Harbour Light's booking agent in the terminal: the same hotel, rules and tools as the /hotel page.

    python examples/hotel/hotel_agent.py                 # you are the guest
    python examples/hotel/hotel_agent.py --model claude-sonnet-5-5
    python examples/hotel/hotel_agent.py --model gpt-5.4-mini    # a GPT deployment, or the local model's id
    python examples/hotel/hotel_agent.py --reset         # a fresh hotel first

Type as the guest. /pay pays the latest deposit on the pretend payment page, /board shows the bookings and outbox,
/desk SEA 2026-11-11 2026-11-12 has reception sell a room (to try the double-booking guard), /quit ends. The database
is generated/hotel/hotel.db, which the page uses too. Confirmations stay in the outbox here; real sending is the
backend's (HOTEL_SMS_TO, HOTEL_EMAIL_TO). About $0.001 a message on Haiku.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hotel as rules  # noqa: E402
from common import CLAUDE_MODEL, cost_usd, create, make_client, run  # noqa: E402

DB = ROOT / "generated" / "hotel" / "hotel.db"


def show_board(hotel: rules.Hotel) -> None:
    board = hotel.board()
    for b in board["bookings"][:8]:
        print(f"  {b['ref']}  {b['guest_name']:<14} room {b['room_number']}  {b['check_in']} to {b['check_out']}  "
              f"£{b['total']:.0f}  {b['status']}/{b['payment_status']}")
    for o in board["outbox"][:6]:
        print(f"  outbox {o['channel']:<5} to {o['to']}: {o['subject'] or o['body'][:70]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=CLAUDE_MODEL, help="Claude, a GPT deployment or the local model")
    parser.add_argument("--reset", action="store_true", help="delete the hotel database and start again")
    args = parser.parse_args()
    if args.reset:
        DB.unlink(missing_ok=True)
    hotel = rules.Hotel(DB)
    chat, client, total, token = rules.Chat(hotel), make_client(), 0.0, None
    print(f"{rules.HOTEL['name']}, {rules.HOTEL['town']}. Today is {rules.pretty(hotel.today)}. You are the guest.\n")
    while True:
        try:
            text = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not text:
            continue
        if text == "/quit":
            break
        if text == "/board":
            show_board(hotel)
            continue
        if text == "/pay":
            print(f"  Payment page: {hotel.pay(token)['message'] if token else 'No deposit is waiting.'}")
            continue
        if text.startswith("/desk"):
            try:
                _, code, ci, co = text.split()
                print(f"  Front desk: {hotel.front_desk(code.upper(), date.fromisoformat(ci), date.fromisoformat(co))['message']}")
            except ValueError:
                print("  Use: /desk SEA 2026-11-11 2026-11-12")
            continue
        screened, removed = chat.guest_says(text)
        if removed:
            print(f"  (removed before the agent saw it: {', '.join(removed)})")

        def charge(response) -> None:
            nonlocal total
            total += cost_usd(response.usage, args.model) or 0

        reply, steps = rules.claude_turn(lambda **p: create(client, **p), chat, args.model, screened,
                                         on_response=charge)
        for s in steps:
            print(f"  tool {s['tool']}({json.dumps(s['args'])}) -> {json.dumps(s['result'])[:200]}")
        for link in chat.payment_links:
            token = link["token"]
            print(f"  [payment page: £{link['amount']:.2f} deposit for {link['ref']}; type /pay to pay it]")
        print(f"Agent: {reply.strip()}\n")
    print(f"\nEstimated cost: ${total:.4f}")


if __name__ == "__main__":
    run(main)
