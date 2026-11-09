"""Handoff orchestration, also called routing, triage or dispatch.

The active agent either deals with the task or passes full control to a better-placed agent. Use it when you can't tell
which specialist is needed until the work is under way. If the input alone tells you, use deterministic routing
(see 09_routing.py). The turn limit is what stops two agents passing a task back and forth for ever.

    python 04_handoff.py
"""
from agent_framework import tool
from agent_framework.orchestrations import HandoffBuilder

from _wf import Lab, main

TITLE = "Handoff"
TASK = "Order PC-1042: you charged me twice for my e-bike, and the battery arrived damaged so I want to send it back."
ORDERS = {"PC-1042": {"item": "Trail e-bike", "paid_gbp": [1899, 1899], "price_gbp": 1899, "delivered_days_ago": 6}}


def build(lab: Lab):
    @tool
    def get_order(order_id: str) -> dict:
        """The shop's record of one order."""
        lab.trace.event("note", text=f"Tool call: get_order({order_id})")
        return ORDERS.get(order_id, {"error": "no such order"})

    # Handoff needs each agent to record its conversation after every model call, so a transfer can carry it over.
    keep = {"require_per_service_call_history_persistence": True}
    triage = lab.agent("triage", "You route customer messages and never answer them yourself. Hand off to billing "
                                 "first if money is involved, otherwise to returns.", **keep)
    billing = lab.agent("billing", "Check the order and say in under 40 words what you will refund. If the customer "
                                   "also wants a return, hand off to returns. Otherwise end with RESOLVED.",
                        tools=[get_order], **keep)
    returns = lab.agent("returns", "Check the order. Our return window is 30 days. Say in under 40 words what happens "
                                   "next, and end with RESOLVED.", tools=[get_order], **keep)

    def resolved(conversation: list) -> bool:
        return bool(conversation) and "RESOLVED" in (conversation[-1].text or "")

    return (HandoffBuilder(name="support_handoff", participants=[triage, billing, returns], termination_condition=resolved)
            .with_start_agent(triage)
            .add_handoff(triage, [billing, returns])
            .add_handoff(billing, [returns])
            .with_autonomous_mode(turn_limits={"triage": 2, "billing": 3, "returns": 3})
            .build())


if __name__ == "__main__":
    main(__file__)
