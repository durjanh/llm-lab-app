"""The engagement tracker's data and tools, as plain Python functions every SDK can wrap.

The data is the same sample as the MCP server in examples/mcp (imported from it), so tasks 2 and 3 see
identical results whether the tools are Python functions or MCP tools. Results are JSON-friendly dicts;
problems come back as {"error": ...} so the model can read them and recover.
"""

import sys
from datetime import date
from typing import Literal

from .config import ROOT

sys.path.insert(0, str(ROOT / "examples" / "mcp"))
from engagements_data import sample_store  # noqa: E402  (pydantic only, no MCP SDK)

STORE = sample_store()
WRITES: list[dict] = []  # every log_risk call that ran, for the checks


def search_engagements(query: str = "", status: Literal["active", "closed", "all"] = "active") -> dict:
    """Find engagements by client, name, partner or summary. Returns short summaries; use get_engagement for details.

    Args:
        query: Words to match, such as a client or partner name. Empty matches every engagement.
        status: active (default), closed, or all.
    """
    words = query.lower().split()
    found = [e for e in STORE.engagements.values()
             if (status == "all" or e.status == status)
             and all(w in f"{e.client} {e.name} {e.partner} {e.summary}".lower() for w in words)]
    return {"engagements": [{"id": e.id, "client": e.client, "name": e.name, "status": e.status,
                             "open_risks": len(e.risks)} for e in found]}


def get_engagement(engagement_id: str) -> dict:
    """The full record of one engagement: partner, dates, budget and spend, percentage of budget used, and its risks.

    Args:
        engagement_id: The engagement's id, such as ENG-104.
    """
    e = STORE.engagements.get(engagement_id.strip().upper())
    if e is None:
        return {"error": f"No engagement {engagement_id!r}. Ids look like ENG-104; use search_engagements to find one."}
    return {**e.model_dump(), "budget_used_percent": round(100 * e.spent_gbp / e.budget_gbp, 1)}


def log_risk(engagement_id: str, title: str, severity: Literal["low", "medium", "high"], owner: str) -> dict:
    """Record a new risk on an active engagement. This WRITES data: a person must approve it first.

    Args:
        engagement_id: The engagement's id, such as ENG-104.
        title: One sentence saying what could go wrong.
        severity: low, medium or high.
        owner: The person who will manage the risk.
    """
    e = STORE.engagements.get(engagement_id.strip().upper())
    if e is None or e.status != "active":
        return {"error": f"{engagement_id} is not an active engagement."}
    risk, _ = STORE.add_risk(e.id, title.strip(), severity, owner.strip(), key=f"{e.id}:{title.strip().lower()}")
    WRITES.append({"engagement_id": e.id, "title": risk.title, "severity": severity, "owner": owner.strip(),
                   "raised": date.today().isoformat()})
    return {"logged": risk.model_dump(), "engagement_id": e.id}


READ_TOOLS = [search_engagements, get_engagement]
ALL_TOOLS = [search_engagements, get_engagement, log_risk]
WRITE_TOOLS = {"log_risk"}  # the harness must ask a person before these run
