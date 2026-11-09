"""Concurrent orchestration, also called fan-out/fan-in, scatter-gather or map-reduce.

Several agents work on the same task at once, independently, and something combines their answers. Use it for
independent views, or when latency matters. It needs a rule for resolving disagreement, which here is the chair.
Avoid it when agents depend on each other's work, or your model quota is tight: every branch is a full model call.

    python 02_concurrent.py
"""
from agent_framework.orchestrations import ConcurrentBuilder

from _wf import SHOP, Lab, main

TITLE = "Concurrent (fan-out/fan-in)"
TASK = f"Should {SHOP} move its customer support inbox to an AI assistant this year?"


def build(lab: Lab):
    chair = lab.agent("chair", "You receive independent views. Give one recommendation in under 60 words, and say "
                               "which point of disagreement decided it.")

    async def decide(results: list) -> str:
        views = "\n\n".join(f"{r.executor_id}: {r.agent_response.text}" for r in results)
        return (await chair.run(views)).text

    return ConcurrentBuilder(participants=[
        lab.agent("finance", "Judge this only on cost and payback. Under 40 words."),
        lab.agent("risk", "Judge this only on what could go wrong for customers and the law. Under 40 words."),
        lab.agent("support_lead", "Judge this only on the day-to-day work of the support team. Under 40 words."),
    ]).with_aggregator(decide).build()


if __name__ == "__main__":
    main(__file__)
