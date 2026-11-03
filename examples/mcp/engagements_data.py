"""The engagement tracker's sample data, with no MCP dependency, so any Python environment can load it.

Used by server.py here and by the SDK comparison in examples/sdks.
"""
from __future__ import annotations

import threading
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

Severity = Literal["low", "medium", "high"]


# In memory, so the example runs anywhere. A real server would read a database or an internal
# API here; nothing else in the file would change.

class Risk(BaseModel):
    id: str
    title: str
    severity: Severity
    owner: str
    raised: str


class Engagement(BaseModel):
    id: str
    client: str
    name: str
    status: Literal["active", "closed"]
    partner: str
    start: str
    end: str
    budget_gbp: int
    spent_gbp: int
    summary: str
    risks: list[Risk] = Field(default_factory=list)


class Store:
    def __init__(self, engagements: list[Engagement]):
        self.engagements = {e.id: e for e in engagements}
        self.by_key: dict[str, str] = {}  # idempotency key -> risk id
        self.lock = threading.Lock()
        self.next_risk = 1 + sum(len(e.risks) for e in engagements)

    def add_risk(self, engagement_id: str, title: str, severity: Severity, owner: str, key: str) -> tuple[Risk, bool]:
        """The risk and whether it is new. The same key returns the risk it made the first time."""
        with self.lock:
            if key in self.by_key:
                risk_id = self.by_key[key]
                return next(r for e in self.engagements.values() for r in e.risks if r.id == risk_id), False
            risk = Risk(id=f"RISK-{self.next_risk}", title=title, severity=severity, owner=owner,
                        raised=date.today().isoformat())
            self.next_risk += 1
            self.engagements[engagement_id].risks.append(risk)
            self.by_key[key] = risk.id
            return risk, True


def sample_store() -> Store:
    return Store([
        Engagement(id="ENG-101", client="Northgate Builders", name="Sale of the plant hire division", status="active",
                   partner="James Carter", start="2026-09-01", end="2027-01-31", budget_gbp=180_000, spent_gbp=96_000,
                   summary="Sell-side support: data room, vendor due diligence and buyer shortlist.",
                   risks=[Risk(id="RISK-1", title="Buyer shortlist depends on audited accounts, due late",
                               severity="high", owner="Tom Hughes", raised="2026-10-02")]),
        Engagement(id="ENG-104", client="Brightwater Logistics", name="Supplier contract renewal", status="active",
                   partner="Priya Shah", start="2026-11-03", end="2027-02-28", budget_gbp=60_000, spent_gbp=4_500,
                   summary="Review the 12 main supplier contracts and recommend renewal terms.",
                   risks=[Risk(id="RISK-2", title="Two contracts auto-renew on 30 November", severity="medium",
                               owner="Sarah Mitchell", raised="2026-10-29")]),
        Engagement(id="ENG-107", client="Aegean Ports Authority", name="Cloud landing zone on AWS", status="active",
                   partner="Eleni Papadakis", start="2026-10-01", end="2027-03-31", budget_gbp=420_000,
                   spent_gbp=150_000, summary="Terraform landing zone, CI/CD and an agent platform for operations.",
                   risks=[]),
        Engagement(id="ENG-090", client="Harbour Retail", name="Data platform assessment", status="closed",
                   partner="James Carter", start="2026-03-02", end="2026-05-29", budget_gbp=45_000, spent_gbp=44_200,
                   summary="Maturity assessment and a 12-month roadmap for the data platform.", risks=[]),
    ])


