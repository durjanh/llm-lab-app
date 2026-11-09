"""Sequential orchestration, also called a pipeline or prompt chaining.

Each agent takes the conversation so far and adds to it, in a fixed order. Use it when each stage depends on the one
before, as in draft, review, polish. Avoid it when stages could run at once, or the work needs to go back a step.

    python 01_sequential.py
"""
from agent_framework.orchestrations import SequentialBuilder

from _wf import SHOP, Lab, main

TITLE = "Sequential"
TASK = f"Tell customers of {SHOP} that e-bikes now take ten working days to deliver instead of five."


def build(lab: Lab):
    return SequentialBuilder(participants=[
        lab.agent("researcher", "List the three facts a customer needs about this change, and what they might worry "
                                "about. Under 50 words."),
        lab.agent("writer", "Write the customer notice from the notes so far. Plain and friendly, under 70 words."),
        lab.agent("editor", "Return the final notice only: fix anything unclear and cut every unnecessary word."),
    ]).build()


if __name__ == "__main__":
    main(__file__)
