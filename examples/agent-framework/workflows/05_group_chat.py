"""Group chat orchestration, also called a roundtable or debate.

Agents share one conversation and a manager picks who speaks next. Use it for brainstorming and reaching agreement.
Microsoft advises three agents or fewer, because the manager's job gets harder and every turn re-reads the whole chat.
max_rounds is the cap that makes sure it ends.

    python 05_group_chat.py
"""
from agent_framework.orchestrations import GroupChatBuilder

from _wf import SHOP, Lab, main

TITLE = "Group chat"
TASK = f"Agree one sentence for the returns page of {SHOP} on how long customers have to return an e-bike."


def build(lab: Lab):
    manager = lab.agent("manager", "You run a short meeting. Hear customer_voice and operations first, then ask "
                                   "copywriter for the wording. End the meeting once copywriter has written a sentence "
                                   "both sides can accept, and give that sentence as the final message.")
    return GroupChatBuilder(
        participants=[
            lab.agent("customer_voice", "Speak for customers: it must be generous and clear. Under 30 words.",
                      description="Argues for what customers want"),
            lab.agent("operations", "Speak for the warehouse: returned e-bikes cost money to handle. Under 30 words.",
                      description="Argues for what the warehouse can afford"),
            lab.agent("copywriter", "Turn the discussion into one sentence for the website. Under 30 words.",
                      description="Writes the wording once positions are known"),
        ],
        orchestrator_agent=manager,
        max_rounds=6,
    ).build()


if __name__ == "__main__":
    main(__file__)
