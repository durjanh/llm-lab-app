"""The prompts and typed outputs shared by every SDK example."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SYSTEM = "You help a consulting delivery team. Use the engagement tools to look things up; never guess figures."

# Task 1: structured output
COMPLAINT = ("My heating stopped on 20 October. A man came the next day but said he needs a part. I am 79 and it is very "
             "cold at night. Nobody has given me a heater. When will it be fixed?")


class Triage(BaseModel):
    """How a housing complaint should be routed."""
    category: Literal["repairs", "rent", "neighbours", "staff conduct", "other"]
    urgency: Literal["low", "medium", "high"] = Field(description="high when health or safety is at risk now")
    summary: str = Field(description="One sentence")


TRIAGE_PROMPT = f"Triage this housing complaint:\n\n{COMPLAINT}"

# Tasks 2 and 3: tools, then the same tools over MCP
QUESTION = "Which active engagements have a high-severity risk, and what percentage of their budget has been used?"

# Task 4: an autonomous agent with a human-approved write
GOAL = ("Review every active engagement. Any engagement that has used more than 30% of its budget and has no "
        "high-severity risk needs a medium-severity risk logged with the title \"Budget burn ahead of plan: review the "
        "forecast\", owned by the engagement's partner. Log only those, then report what you did and why.")

# Task 5: multi-agent
UPDATE_BRIEF = ("Write a three-bullet weekly update for the client of engagement ENG-101: progress, budget used, "
                "and the open risks with their owners.")
RESEARCHER = "You are a researcher. Use the engagement tools to gather the facts needed, then report them plainly."
WRITER = ("You are a writer. Turn the researcher's facts into exactly three short bullets for the client, naming the client "
          "and the engagement. Do not invent facts.")
