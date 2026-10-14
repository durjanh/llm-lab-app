"""The same agent, with the SDK's tool runner (beta) writing the loop for you.

Companion to the Agents & tools lab. Compare with 06_agent_loop.py: you write
only the tool functions. Approval still lives inside send_email, so the model
cannot get around it.

    python 07_tool_runner.py
    python 07_tool_runner.py --task "What's the weather in Paris tomorrow?"
"""
from __future__ import annotations

import argparse
import json

from anthropic import beta_tool

from common import describe_usage, fallback_params, make_client, model_argument, run

WEATHER = {"london": "Rain likely, 80% chance, 14°C", "paris": "Sunny, 19°C"}
ORDERS = {"1042": {"status": "shipped", "customer_id": "C-77", "tracking": "ZX93"}}
CUSTOMERS = {"C-77": {"name": "Sam Patel", "email": "sam@example.com"}}
AUTO_APPROVE = False


@beta_tool
def get_weather(city: str, date: str) -> str:
    """Get the weather forecast for a city on a given day.

    Args:
        city: City name, for example London.
        date: An ISO date or 'tomorrow'.
    """
    return WEATHER.get(city.strip().lower(), f"Error: unknown city '{city}'.")


@beta_tool
def get_order(order_id: str) -> str:
    """Look up an order by id. Returns status, customer id and tracking number.

    Args:
        order_id: The order id, for example 1042.
    """
    return json.dumps(ORDERS.get(order_id, {"error": f"No order with id {order_id}"}))


@beta_tool
def get_customer(customer_id: str) -> str:
    """Look up a customer by id. Returns name and email address.

    Args:
        customer_id: The customer id, for example C-77.
    """
    return json.dumps(CUSTOMERS.get(customer_id, {"error": f"No customer with id {customer_id}"}))


@beta_tool
def send_email(to: str, subject: str, body: str) -> str:
    """Send an email to a customer. A person approves every email before it is sent.

    Args:
        to: The customer's email address.
        subject: The subject line.
        body: The message body.
    """
    if to not in {c["email"] for c in CUSTOMERS.values()}:
        return f"Error: {to} is not a customer address on file. Email not sent."
    print(f"\n  Approval needed. To: {to}\n  Subject: {subject}\n  {body}\n")
    if AUTO_APPROVE or input("  Send this email? [y/N] ").strip().lower() == "y":
        return "sent"
    return "Error: a person declined to send this email."


def main() -> None:
    global AUTO_APPROVE
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--task", default="Let the customer for order 1042 know it has shipped.")
    parser.add_argument("--auto-approve", action="store_true")
    model_argument(parser)
    args = parser.parse_args()
    AUTO_APPROVE = args.auto_approve
    client = make_client()

    runner = client.beta.messages.tool_runner(
        model=args.model,
        max_tokens=16000,
        system="You are a customer support agent for Northwind. Use the tools to help staff.",
        tools=[get_weather, get_order, get_customer, send_email],
        messages=[{"role": "user", "content": args.task}],
        **fallback_params(args.model),
    )
    print(f"User: {args.task}\n")
    for message in runner:  # one message per loop iteration
        for block in message.content:
            if block.type == "tool_use":
                print(f"  tool call: {block.name}({json.dumps(block.input)})")
            elif block.type == "text" and block.text.strip():
                print(f"  model says: {block.text.strip()}")
        print(f"  [stop_reason={message.stop_reason} · {describe_usage(message.usage, args.model)}]")
    if message.stop_reason == "refusal":
        print("The request was declined.")


if __name__ == "__main__":
    run(main)
