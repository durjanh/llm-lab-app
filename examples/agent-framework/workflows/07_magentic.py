"""Magentic orchestration, also called dynamic or task-ledger-based orchestration.

A manager writes a plan (the task ledger), then after every step updates a progress ledger and picks who acts next,
replanning if the work stalls. Use it for open-ended problems with no known route. It is the slowest and dearest type
here. Avoid it when the route is known. The round, stall and reset limits are what stop it: in testing, workers that
kept asking for data nobody had sent the manager round in a loop until the reset limit ended the run.

    python 07_magentic.py
"""
from agent_framework.orchestrations import MagenticBuilder

from _wf import SHOP, Lab, main

TITLE = "Magentic"
TASK = (f"E-bike returns at {SHOP} rose from 4% to 9% in three months. Work out the most likely causes to look at "
        "first, and recommend one action.")


def build(lab: Lab):
    return MagenticBuilder(
        participants=[
            lab.agent("analyst", "You reason about retail numbers and likely causes. You have no data beyond the task, so never ask for "
                                 "more: state your assumptions and answer. Under 60 words.",
                      description="Reasons about numbers and possible causes"),
            lab.agent("ops_expert", "You know bike logistics, packing and battery handling. Never ask for more data: state your "
                                    "assumptions and answer. Under 60 words.",
                      description="Knows logistics, packing and how batteries get damaged"),
        ],
        manager_agent=lab.agent("manager", "You coordinate a small team and keep plans short.", description="Plans the work"),
        max_round_count=6,
        max_stall_count=2,
        max_reset_count=1,
    ).build()


if __name__ == "__main__":
    main(__file__)
