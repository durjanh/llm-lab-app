"""An agent loop written by hand: the model asks for tools, your code runs them.

Companion to the Agents & tools lab. Three scenarios match the lab's simulator.
The tools use small in-memory data so nothing real is touched. send_email asks
you for approval before it "sends", and only allows addresses on file.

    python 06_agent_loop.py --scenario weather
    python 06_agent_loop.py --scenario parallel      # two calls at once, one fails
    python 06_agent_loop.py --scenario order          # several steps plus approval
"""
from __future__ import annotations

import argparse
import json

from common import create, cost_usd, describe_usage, ensure_answered, make_client, model_argument, run, text_of

WEATHER = {
    "london": {"forecast": "rain", "chance_of_rain": 0.8, "temp_c": 14},
    "paris": {"forecast": "sunny", "chance_of_rain": 0.1, "temp_c": 19},
    "manchester": {"forecast": "showers", "chance_of_rain": 0.6, "temp_c": 12},
}
ORDERS = {"1042": {"order_id": "1042", "status": "shipped", "customer_id": "C-77", "tracking": "ZX93"}}
CUSTOMERS = {"C-77": {"name": "Sam Patel", "email": "sam@example.com"}}


def tool(name: str, description: str, properties: dict) -> dict:
    return {
        "name": name,
        "description": description,
        "strict": True,  # tool inputs are guaranteed to match the schema
        "input_schema": {"type": "object", "properties": properties,
                         "required": list(properties), "additionalProperties": False},
    }


TOOLS = {
    "get_weather": tool("get_weather", "Get the weather forecast for a city on a given day.",
                        {"city": {"type": "string", "description": "City name, for example London"},
                         "date": {"type": "string", "description": "An ISO date or 'tomorrow'"}}),
    "get_order": tool("get_order", "Look up an order by id. Returns status, customer id and tracking number.",
                      {"order_id": {"type": "string"}}),
    "get_customer": tool("get_customer", "Look up a customer by id. Returns name and email address.",
                         {"customer_id": {"type": "string"}}),
    "send_email": tool("send_email", "Send an email to a customer. A person approves every email before it is sent.",
                       {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}),
}
SCENARIOS = {
    "weather": (["get_weather"], "You are a helpful travel assistant.",
                "I'm in London tomorrow. Do I need an umbrella?"),
    "parallel": (["get_weather"], "You are a helpful travel assistant.",
                 "Compare tomorrow's weather in Paris and Atlantis."),
    "order": (["get_order", "get_customer", "send_email"],
              "You are a customer support agent for Northwind. Use the tools to help staff.",
              "Let the customer for order 1042 know it has shipped."),
}


class ToolError(Exception):
    """A failure the model should hear about, returned as an error tool result."""


def execute(name: str, args: dict, auto_approve: bool) -> dict:
    if name == "get_weather":
        city = args["city"].strip().lower()
        if city not in WEATHER:
            raise ToolError(f"Unknown city '{args['city']}'. Use a real city name.")
        return WEATHER[city]
    if name == "get_order":
        if args["order_id"] not in ORDERS:
            raise ToolError(f"No order with id {args['order_id']}.")
        return ORDERS[args["order_id"]]
    if name == "get_customer":
        if args["customer_id"] not in CUSTOMERS:
            raise ToolError(f"No customer with id {args['customer_id']}.")
        return CUSTOMERS[args["customer_id"]]
    if name == "send_email":
        allowed = {c["email"] for c in CUSTOMERS.values()}
        if args["to"] not in allowed:  # allow-list: only customers on file
            raise ToolError(f"{args['to']} is not a customer address on file. Email not sent.")
        print(f"\n  Approval needed. To: {args['to']}\n  Subject: {args['subject']}\n  {args['body']}\n")
        approved = auto_approve or input("  Send this email? [y/N] ").strip().lower() == "y"
        if not approved:
            raise ToolError("A person declined to send this email.")
        return {"status": "sent"}
    raise ToolError(f"Unknown tool {name}.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scenario", choices=list(SCENARIOS), default="weather")
    parser.add_argument("--auto-approve", action="store_true", help="approve emails without asking")
    parser.add_argument("--max-steps", type=int, default=10)
    model_argument(parser)
    args = parser.parse_args()
    client = make_client()

    tool_names, system, question = SCENARIOS[args.scenario]
    tools = [TOOLS[n] for n in tool_names]
    messages: list[dict] = [{"role": "user", "content": question}]
    print(f"User: {question}\n")
    total = 0.0

    for step in range(1, args.max_steps + 1):
        response = create(client, model=args.model, max_tokens=16000, system=system, tools=tools, messages=messages)
        total += cost_usd(response.usage, args.model) or 0
        print(f"API call {step}: stop_reason={response.stop_reason} · {describe_usage(response.usage, args.model)}")
        messages.append({"role": "assistant", "content": response.content})  # keep every block
        ensure_answered(response)
        if response.stop_reason != "tool_use":
            break

        results = []
        for block in response.content:
            if block.type == "text" and block.text.strip():
                print(f"  model says: {block.text.strip()}")
            if block.type != "tool_use":
                continue
            print(f"  tool call: {block.name}({json.dumps(block.input)})")
            try:
                output = execute(block.name, block.input, args.auto_approve)
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(output)})
                print(f"  result: {output}")
            except ToolError as exc:
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": f"Error: {exc}",
                                "is_error": True})
                print(f"  error returned to the model: {exc}")
        messages.append({"role": "user", "content": results})  # all results in one message
    else:
        print(f"Stopped after {args.max_steps} API calls without finishing.")

    print(f"\nAssistant: {text_of(response).strip()}")
    print(f"\nEstimated cost: ${total:.4f} over {step} API calls. Each call resent the whole conversation.")


if __name__ == "__main__":
    run(main)
