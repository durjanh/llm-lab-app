"""Closed-deal agents: when a deal is marked closed-won in an invented CRM, a chain of small steps finds accounts that
look like the one just won and drafts outreach to them, and a person approves or rejects every draft.

Three steps are a model (it reads the win notes, judges each look-alike account, and writes each email). The others
are code: the look-alike search and its similarity score, the competitor notes, the thresholds that turn scores into
a priority, the choice of contact, and every rule on what may be sent. Those rules are checked again when a person
approves, because consent and the day's count can change between drafting and sending.

Nothing is ever emailed. "Sent" is a row in the database. The company, its customers and its competitors are invented.
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, Iterator

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, text_of
from .runs import Run, RunStreamer
from .spend import SpendTracker

COMPANY = "Larkfield"
PRODUCT = "Larkfield Forecast"
DAILY_CAP = 3  # emails a day, across every run; small so the cap is easy to reach when trying the page
MAX_CANDIDATES = 6
MAX_WORDS = 140
FOOTER = (f"You are receiving this because you agreed to hear from {COMPANY}. Reply STOP and we will not email you "
          "again.")
# Priority, from the combined score out of 100: half from the similarity code works out, half from the model's ratings.
PRIORITY_A, PRIORITY_B = 65, 45

# The steps, in order, for the page's graph. "who" is what does the work.
STEPS: list[dict[str, str]] = [
    {"id": "trigger", "name": "Deal closed", "who": "code", "does": "Marks the deal closed-won in the CRM"},
    {"id": "win", "name": "Win analyst", "who": "model", "does": "Reads the win notes: why we won, and a proof point with no customer name"},
    {"id": "finder", "name": "Opportunity finder", "who": "code", "does": "Finds look-alike accounts and scores how similar each is"},
    {"id": "competitor", "name": "Competitor lookup", "who": "code", "does": "Attaches the notes on each account's current supplier"},
    {"id": "classify", "name": "Classifier", "who": "model", "does": "Rates need and timing for each account; code turns the scores into a priority"},
    {"id": "enrich", "name": "Enrichment", "who": "code", "does": "Picks a contact who has agreed to email, and checks the day's limit"},
    {"id": "email", "name": "Emailer", "who": "model", "does": "Drafts one email for each priority A account; code checks every draft"},
    {"id": "approval", "name": "Your approval", "who": "person", "does": "Nothing is sent until you approve it; the rules are checked again then"},
]

RULES = [
    "Only a contact who has agreed to email, and has not unsubscribed, is ever written to.",
    "An email never names the customer whose deal was just won, or anyone who works there.",
    f"At most {DAILY_CAP} emails are sent in a day, across every run.",
    f"A draft is at most {MAX_WORDS} words, and code adds the opt-out line itself.",
    "Nothing is sent without a person's approval, and sending is simulated: a row in the database.",
]

SCHEMA_SQL = """
CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, aliases TEXT, industry TEXT, employees INTEGER, region TEXT,
                       tech TEXT, current_vendor TEXT, notes TEXT);
CREATE TABLE contacts (id TEXT PRIMARY KEY, account_id TEXT, name TEXT, role TEXT, seniority INTEGER, email TEXT,
                       consent INTEGER, unsubscribed INTEGER);
CREATE TABLE deals (id TEXT PRIMARY KEY, account_id TEXT, name TEXT, value_gbp INTEGER, stage TEXT, closed_on TEXT,
                    win_notes TEXT, displaced TEXT);
CREATE TABLE competitors (name TEXT PRIMARY KEY, strengths TEXT, weaknesses TEXT, typical_customer TEXT);
CREATE TABLE outreach (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, deal_id TEXT, account_id TEXT,
                       contact_id TEXT, subject TEXT, body TEXT, status TEXT, reason TEXT, created_at TEXT,
                       decided_at TEXT);
"""

# id, name, aliases, industry, employees, region, tech, current supplier, notes
ACCOUNTS = [
    ("A01", "Harrow & Vale Grocers", "Harrow and Vale,Harrow & Vale", "grocery retail", 2400, "North West", "SAP,Snowflake,Power BI", "Brightcast", "42 stores. Fresh food waste was the board's top cost concern."),
    ("A02", "Pennine Fresh Markets", "Pennine Fresh", "grocery retail", 1900, "North West", "SAP,Snowflake,Tableau", "Brightcast", "36 stores. New supply chain director started in September. Waste targets missed two quarters running."),
    ("A03", "Castlegate Foods", "Castlegate", "grocery retail", 3100, "Yorkshire", "Oracle,Snowflake,Power BI", "Tallymark", "Convenience chain, 110 small shops. Contract with current supplier ends in March."),
    ("A04", "Dunmore Garden Centres", "Dunmore", "garden retail", 800, "Midlands", "Sage,Excel", "", "Seasonal stock. Forecasts are done in spreadsheets by two planners."),
    ("A05", "Kestrel Pharmacy Group", "Kestrel Pharmacy,Kestrel", "pharmacy retail", 2600, "North West", "SAP,Power BI", "Brightcast", "Short-dated medicines are written off every month. Asked two vendors for a demo last year, then paused."),
    ("A06", "Ashby Freight", "Ashby", "logistics", 1200, "Midlands", "Oracle,Databricks", "Quorra Planning", "Pallet network. Happy with current planning tool; renewed for three years in June."),
    ("A07", "Marlow Bakeries", "Marlow", "food manufacturing", 950, "South East", "SAP,Snowflake", "Tallymark", "Daily production plans for 60 shops. Over-baking is a known cost; finance has asked for a fix this year."),
    ("A08", "Tynebridge Co-operative", "Tynebridge", "grocery retail", 4200, "North East", "SAP,Snowflake,Power BI", "Brightcast", "140 stores. Members voted for a food waste pledge. IT is mid-way through a till replacement until summer."),
    ("A09", "Orchard Lane Wholesale", "Orchard Lane", "food wholesale", 600, "South West", "Sage,Power BI", "", "Sells to cafes and schools. No planning system."),
    ("A10", "Fenwick Hill Dairies", "Fenwick Hill", "food manufacturing", 1500, "North West", "SAP,Snowflake,Power BI", "Tallymark", "Milk and yoghurt for supermarkets. Short shelf life; forecast error blamed for a lost contract last spring."),
    ("A11", "Solway Outdoor", "Solway", "outdoor retail", 700, "Scotland", "Shopify,Excel", "", "Online first. Not a fit for store-level forecasting."),
    ("A12", "Greyfriars Convenience", "Greyfriars", "grocery retail", 1300, "Scotland", "Oracle,Power BI", "Quorra Planning", "75 forecourt shops. Chilled range growing fast. Planning lead has posted about waste on a trade forum."),
    ("A13", "Redcliffe Cash & Carry", "Redcliffe", "food wholesale", 1100, "North West", "SAP,Excel", "", "Existing customer since last year."),
    ("A14", "Lowther Hospital Supplies", "Lowther", "healthcare supply", 500, "North East", "Oracle,Excel", "Quorra Planning", "Open deal in progress with our team."),
]

# id, account, name, role, seniority (higher is more senior), agreed to email, unsubscribed
CONTACTS = [
    ("C01", "A01", "Priya Raman", "Supply Chain Director", 3, 1, 0), ("C02", "A01", "Tom Ellison", "Head of Fresh", 2, 1, 0),
    ("C03", "A02", "Helen Okafor", "Supply Chain Director", 3, 1, 0), ("C04", "A02", "Raj Bedi", "Demand Planner", 1, 1, 0),
    ("C05", "A03", "Marcus Lindqvist", "Chief Operating Officer", 4, 0, 0), ("C06", "A03", "Aoife Brennan", "Head of Supply", 2, 1, 0),
    ("C07", "A04", "Gareth Pugh", "Operations Manager", 2, 1, 0),
    ("C08", "A05", "Dr Nadia Hussein", "Superintendent Pharmacist", 3, 0, 0), ("C09", "A05", "Liam Cartwright", "Head of Stock", 2, 1, 1),
    ("C10", "A06", "Sandra Whitlock", "Planning Director", 3, 1, 0),
    ("C11", "A07", "Imran Sheikh", "Finance Director", 3, 1, 0), ("C12", "A07", "Beth Marlow", "Production Planner", 1, 1, 0),
    ("C13", "A08", "Olu Adeyemi", "Head of Supply Chain", 3, 1, 0),
    ("C14", "A09", "Fiona Trent", "Owner", 4, 1, 0),
    ("C15", "A10", "Catrin Howell", "Commercial Director", 3, 1, 0), ("C16", "A10", "Dev Malhotra", "Demand Planner", 1, 0, 0),
    ("C17", "A11", "Isla Graham", "Head of Ecommerce", 2, 1, 0),
    ("C18", "A12", "Ewan Sutherland", "Planning Lead", 2, 1, 0),
    ("C19", "A13", "Peter Voss", "Buying Director", 3, 1, 0), ("C20", "A14", "Ruth Amadi", "Procurement Lead", 2, 1, 0),
]

# id, account, name, value, stage, win notes (written by the sales team, so they name the customer), displaced supplier
DEALS = [
    ("D01", "A01", "Harrow & Vale: store-level fresh forecasting", 186000, "open",
     "Harrow & Vale Grocers chose us after a 10-week pilot in 8 stores. Priya Raman's team saw fresh food waste fall by "
     "31% and availability hold at 97%. Brightcast forecasts by region and week; we forecast by store and day, which is "
     "what their fresh buyers needed. Their Snowflake data was connected in 9 days. The trigger was a board target to "
     "cut waste by a quarter this year. Tom Ellison (Head of Fresh) was the champion; finance signed after seeing the "
     "pilot numbers.", "Brightcast"),
    ("D02", "A14", "Lowther: ward stock forecasting", 64000, "open",
     "Lowther Hospital Supplies want fewer emergency orders. Ruth Amadi ran a 6-week trial on three hospital trusts' "
     "order history: stock-outs fell from 41 a month to 12. Quorra Planning needed a consultant to change any forecast "
     "rule; our planners changed them themselves. The trigger was a penalty clause for late deliveries in their new "
     "framework contract.", "Quorra Planning"),
    ("D03", "A13", "Redcliffe: first year", 52000, "closed_won", "Signed last year after a short trial.", ""),
]

COMPETITORS = [
    ("Brightcast", "Well known; good dashboards; strong in fashion retail",
     "Forecasts by region and week, not by store and day; fresh and short-life products are a known weak spot",
     "Large retailers with long-life products"),
    ("Tallymark", "Cheap; bundled with their accounting suite",
     "Forecast rules are fixed; no daily forecasts; data must be exported by hand each week",
     "Mid-sized firms already on their accounting suite"),
    ("Quorra Planning", "Very configurable; strong in logistics and network planning",
     "Changes need a consultant; long projects; customers who renewed recently are locked in for years",
     "Logistics firms and distributors"),
]

WIN_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "required": ["why_won", "pains", "trigger", "proof_point"],
    "properties": {"why_won": {"type": "string"}, "pains": {"type": "array", "items": {"type": "string"}},
                   "trigger": {"type": "string"}, "proof_point": {"type": "string"}},
}

WIN_SYSTEM = f"""You read a sales team's notes on a deal {COMPANY} has just won for {PRODUCT}, and say why it was won,
as JSON, so the same case can be made to similar companies.
- why_won: one or two sentences on what decided it.
- pains: the customer's problems before, as short phrases (two to four).
- trigger: the event that made them act now, in one short sentence.
- proof_point: one sentence with the result and its numbers that could be quoted to another company. It must NOT name
  the customer or any person: describe them by kind and size instead ("a regional grocer with about 40 stores")."""

CLASSIFY_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["accounts"],
    "properties": {"accounts": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["account_id", "need", "timing", "angle", "reason"],
        "properties": {"account_id": {"type": "string"}, "need": {"type": "integer"}, "timing": {"type": "integer"},
                       "angle": {"type": "string"}, "reason": {"type": "string"}}}}},
}

CLASSIFY_SYSTEM = f"""{COMPANY} has just won a deal. You are given why it was won and a list of other accounts that look
similar, each with our notes on it and on the supplier it uses now. Rate every account in the list, as JSON.
- account_id: exactly as given. Rate each account once; do not add accounts.
- need: 0 to 10. How strongly the notes show the same problem the won customer had. 0 when nothing suggests it.
- timing: 0 to 10. How good the moment is: a new decision maker, a contract ending or a stated target raise it; a
  recent renewal or a system change in progress lower it.
- angle: one sentence on what to say to this account, given its current supplier's weak spots.
- reason: one sentence explaining the two ratings, from the notes only.
Do not decide who gets an email: code does that from your ratings."""

EMAIL_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["subject", "body"],
    "properties": {"subject": {"type": "string"}, "body": {"type": "string"}},
}

EMAIL_SYSTEM = f"""You draft a first email from {COMPANY}, which sells {PRODUCT}, to one person at a company that looks
like a customer we have just won. A salesperson will read and approve it before anything is sent. Answer as JSON.
- subject: under 70 characters, plain, no capitals for effect.
- body: at most {MAX_WORDS - 30} words. Greet them by first name. Say what similar companies struggle with, give the
  proof point as it is written, make the one point in the angle, and ask for a 20-minute call. Sign off as
  "The {COMPANY} team".
Rules: never name the customer the proof point is about, or guess who it is. Do not run down their current supplier by
name. No invented numbers: use only those in the proof point. No opt-out line: code adds it."""


def _words(text: str) -> int:
    return len(re.findall(r"\b[\w'’-]+\b", text))


def similarity(won: dict, other: dict, displaced: str) -> dict[str, Any]:
    """How like the won account another account is, out of 100, with the parts that make it up."""
    shared = sorted(set(won["tech"].split(",")) & set(other["tech"].split(",")) - {""})
    ratio = other["employees"] / won["employees"] if won["employees"] else 0
    parts = {
        "same industry": 40 if other["industry"] == won["industry"] else 0,
        "similar size": 20 if 0.5 <= ratio <= 2 else 0,
        "same region": 15 if other["region"] == won["region"] else 0,
        "shared systems": min(15, 5 * len(shared)),
        "uses the supplier we displaced": 10 if displaced and other["current_vendor"] == displaced else 0,
    }
    return {"score": sum(parts.values()), "parts": parts, "shared_systems": shared}


def priority(similar: int, need: int, timing: int) -> dict[str, Any]:
    """The combined score out of 100 and the priority it earns. Thresholds are fixed here, not chosen by the model."""
    combined = round(0.5 * similar + 3 * need + 2 * timing)
    return {"combined": combined, "priority": "A" if combined >= PRIORITY_A else "B" if combined >= PRIORITY_B else "skip"}


def banned_names(account: dict, contacts: list[dict]) -> list[str]:
    """Every name an email must not contain: the won customer, its other names, and the people who work there."""
    names = [account["name"], *[a for a in account["aliases"].split(",") if a], *[c["name"] for c in contacts]]
    return [n.strip() for n in names if n.strip()]


def named(text: str, names: list[str]) -> list[str]:
    """The banned names found in the text, whatever the capitals or the spacing."""
    flat = re.sub(r"\s+", " ", text).lower()
    return [n for n in names if re.search(rf"(?<!\w){re.escape(n.lower())}(?!\w)", flat)]


def redact(text: str, names: list[str]) -> str:
    for n in sorted(names, key=len, reverse=True):
        text = re.sub(rf"(?<!\w){re.escape(n)}(?!\w)", "a customer", text, flags=re.I)
    return text


def draft_problems(subject: str, body: str, names: list[str]) -> list[str]:
    """Why a draft may not be shown for approval, or nothing when it may."""
    found = [f'it names "{n}", the customer whose deal was won or someone there' for n in named(f"{subject}\n{body}", names)]
    if _words(body) > MAX_WORDS:
        found.append(f"the body is {_words(body)} words; the limit is {MAX_WORDS}")
    if not subject.strip() or not body.strip():
        found.append("the subject or the body is empty")
    if len(subject) > 90:
        found.append("the subject is over 90 characters")
    return found


class DealsService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, root: Path, streamer: RunStreamer | None = None,
                 today: Callable[[], date] = date.today):
        self.claude, self.spend, self.root, self.streamer, self.today = claude, spend, root, streamer, today
        self.path = root / "crm.db"
        self._lock = threading.Lock()

    # ----- the database -----

    def _db(self) -> sqlite3.Connection:
        if not self.path.exists():
            self._seed()
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        return db

    def _seed(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.path.unlink(missing_ok=True)
        db = sqlite3.connect(self.path)
        with db:
            db.executescript(SCHEMA_SQL)
            db.executemany("INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?)", ACCOUNTS)
            db.executemany("INSERT INTO contacts VALUES (?,?,?,?,?,?,?,?)",
                           [(i, a, n, r, s, f"{n.lower().replace('dr ', '').replace(' ', '.')}@example.com", c, u)
                            for i, a, n, r, s, c, u in CONTACTS])
            db.executemany("INSERT INTO deals VALUES (?,?,?,?,?,?,?,?)",
                           [(i, a, n, v, s, "2025-11-03" if s == "closed_won" else None, w, d)
                            for i, a, n, v, s, w, d in DEALS])
            db.executemany("INSERT INTO competitors VALUES (?,?,?,?)", COMPETITORS)
        db.close()

    def _rows(self, sql: str, args: tuple = ()) -> list[dict]:
        with self._lock:
            db = self._db()
            try:
                return [dict(r) for r in db.execute(sql, args)]
            finally:
                db.close()

    def _write(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            db = self._db()
            try:
                with db:
                    return db.execute(sql, args).lastrowid or 0
            finally:
                db.close()

    def reset(self) -> dict[str, Any]:
        """Puts the invented CRM back as it started: deals open again, no outreach."""
        with self._lock:
            self._seed()
        return self.state()

    # ----- what the page shows -----

    def info(self) -> dict[str, Any]:
        return {"steps": STEPS, "rules": RULES, "daily_cap": DAILY_CAP, "model": DEFAULT_MODEL, "company": COMPANY,
                "product": PRODUCT, "thresholds": {"A": PRIORITY_A, "B": PRIORITY_B}}

    def sent_today(self) -> int:
        day = self.today().isoformat()
        return self._rows("SELECT COUNT(*) AS n FROM outreach WHERE status = 'sent' AND substr(decided_at, 1, 10) = ?",
                          (day,))[0]["n"]

    def state(self) -> dict[str, Any]:
        deals = self._rows("SELECT d.id, d.name, d.value_gbp, d.stage, d.closed_on, d.win_notes, d.displaced, "
                           "a.name AS account FROM deals d JOIN accounts a ON a.id = d.account_id ORDER BY d.id")
        outreach = self._rows(
            "SELECT o.id, o.run_id, o.deal_id, o.subject, o.body, o.status, o.reason, o.created_at, o.decided_at, "
            "a.name AS account, c.name AS contact, c.role, c.email FROM outreach o "
            "JOIN accounts a ON a.id = o.account_id LEFT JOIN contacts c ON c.id = o.contact_id ORDER BY o.id DESC")
        sent = self.sent_today()
        return {"deals": deals, "outreach": outreach,
                "cap": {"limit": DAILY_CAP, "sent_today": sent, "left": max(0, DAILY_CAP - sent)},
                "accounts": self._rows("SELECT COUNT(*) AS n FROM accounts")[0]["n"]}

    # ----- the steps -----

    def _call(self, model: str, system: str, user: str, schema: dict, charge: Callable[[Any], None]) -> dict:
        try:
            response = self.claude.create(model=model, max_tokens=2500, system=system,
                                          messages=[{"role": "user", "content": user}],
                                          output_config={"format": {"type": "json_schema", "schema": schema}})
        except Exception as exc:
            raise to_api_error(exc) from exc
        charge(response)
        try:
            return json.loads(text_of(response))
        except json.JSONDecodeError:
            raise ApiError(502, "unreadable", "The model's answer was not the JSON asked for.") from None

    def find_candidates(self, won: dict, displaced: str) -> list[dict]:
        """Look-alike accounts: not the won one, not a customer already, no deal in progress; the most similar first."""
        busy = {r["account_id"] for r in self._rows("SELECT account_id FROM deals")}
        out = []
        for other in self._rows("SELECT * FROM accounts"):
            if other["id"] == won["id"] or other["id"] in busy:
                continue
            sim = similarity(won, other, displaced)
            if sim["score"] >= 40:
                out.append({"account_id": other["id"], "name": other["name"], "industry": other["industry"],
                            "employees": other["employees"], "region": other["region"],
                            "current_vendor": other["current_vendor"], "notes": other["notes"], "similarity": sim})
        return sorted(out, key=lambda c: -c["similarity"]["score"])[:MAX_CANDIDATES]

    def pick_contact(self, account_id: str) -> tuple[dict | None, str]:
        """The most senior person who has agreed to email and has not unsubscribed, or why there is nobody."""
        people = self._rows("SELECT * FROM contacts WHERE account_id = ? ORDER BY seniority DESC", (account_id,))
        for p in people:
            if p["consent"] and not p["unsubscribed"]:
                skipped = [q["name"] for q in people if q["seniority"] > p["seniority"]]
                why = f"{', '.join(skipped)} more senior, but has not agreed to email" if skipped else "most senior contact"
                return p, why
        return None, "nobody at this account has agreed to be emailed" if people else "no contacts on file"

    def close(self, deal_id: str, model: str | None) -> Iterator[str]:
        """Marks the deal closed-won and streams the chain of steps as NDJSON, ending with drafts awaiting approval."""
        model = model or DEFAULT_MODEL
        deals = self._rows("SELECT * FROM deals WHERE id = ?", (deal_id,))
        if not deals:
            raise ApiError(404, "not_found", "There is no deal with that id.")
        deal = deals[0]
        if deal["stage"] != "open":
            raise ApiError(409, "already_closed", "That deal is already closed. Reset the data to run it again.")
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        run = Run()
        return self.streamer.lines(run, lambda: self._work(run, deal, model))

    def _work(self, run: Run, deal: dict, model: str) -> None:
        cost = 0.0

        def charge(response: Any) -> None:
            nonlocal cost
            cost += self.spend.charge(response, model) or 0.0

        def step(step_id: str, status: str, summary: str = "", detail: Any = None) -> None:
            run.publish({"type": "step", "step": step_id, "status": status, "summary": summary, "detail": detail})

        current = "trigger"
        try:
            step("trigger", "running")
            self._write("UPDATE deals SET stage = 'closed_won', closed_on = ? WHERE id = ?",
                        (self.today().isoformat(), deal["id"]))
            won = self._rows("SELECT * FROM accounts WHERE id = ?", (deal["account_id"],))[0]
            names = banned_names(won, self._rows("SELECT name FROM contacts WHERE account_id = ?", (won["id"],)))
            step("trigger", "done", f"{deal['name']} · £{deal['value_gbp']:,}",
                 {"deal": deal["name"], "account": won["name"], "value_gbp": deal["value_gbp"],
                  "displaced": deal["displaced"], "win_notes": deal["win_notes"]})

            current = "win"
            step("win", "running")
            ask = (f"Deal: {deal['name']}\nCustomer: {won['name']} ({won['industry']}, {won['employees']} staff, "
                   f"{won['region']})\nSupplier displaced: {deal['displaced'] or 'none'}\nNotes: {deal['win_notes']}")
            win = self._call(model, WIN_SYSTEM, ask, WIN_SCHEMA, charge)
            leaked = named(win.get("proof_point", ""), names)
            if leaked:  # one more try, then code removes the names itself
                win = self._call(model, WIN_SYSTEM, ask + f"\n\nYour proof point named {', '.join(leaked)}. Answer again "
                                 "with the whole object; the proof point must not name the customer or any person.",
                                 WIN_SCHEMA, charge)
            win["proof_point"] = redact(win.get("proof_point", ""), names)
            win["names_removed_by_code"] = leaked
            step("win", "done", win.get("trigger", ""), win)

            current = "finder"
            step("finder", "running")
            candidates = self.find_candidates(won, deal["displaced"])
            step("finder", "done", f"{len(candidates)} look-alike accounts", candidates)
            if not candidates:
                run.publish({"type": "done", "drafts": 0, "cost_usd": round(cost, 6), **self.state()})
                return

            current = "competitor"
            step("competitor", "running")
            cards = {c["name"]: c for c in self._rows("SELECT * FROM competitors")}
            for c in candidates:
                c["battlecard"] = cards.get(c["current_vendor"])
            using = sorted({c["current_vendor"] for c in candidates if c["current_vendor"]})
            step("competitor", "done", ", ".join(using) or "No supplier on file",
                 [{"account": c["name"], "current_vendor": c["current_vendor"] or "none on file",
                   "weaknesses": (c["battlecard"] or {}).get("weaknesses", "")} for c in candidates])

            current = "classify"
            step("classify", "running")
            listing = "\n\n".join(
                f"account_id: {c['account_id']}\nName: {c['name']} ({c['industry']}, {c['employees']} staff, {c['region']})\n"
                f"Our notes: {c['notes']}\nCurrent supplier: {c['current_vendor'] or 'none on file'}"
                + (f"\nThat supplier's weak spots: {c['battlecard']['weaknesses']}" if c["battlecard"] else "")
                for c in candidates)
            rated = self._call(model, CLASSIFY_SYSTEM,
                               f"Why we won: {win.get('why_won', '')}\nTheir problems: {'; '.join(win.get('pains', []))}\n"
                               f"What made them act: {win.get('trigger', '')}\n\nAccounts to rate:\n\n{listing}",
                               CLASSIFY_SCHEMA, charge)
            by_id = {r.get("account_id"): r for r in rated.get("accounts", []) if isinstance(r, dict)}
            for c in candidates:  # only accounts code found are kept; a missing or wild rating counts as 0
                r = by_id.get(c["account_id"], {})
                need = max(0, min(10, int(r.get("need", 0) or 0)))
                timing = max(0, min(10, int(r.get("timing", 0) or 0)))
                c.update(need=need, timing=timing, angle=str(r.get("angle", "")), reason=str(r.get("reason", "")),
                         **priority(c["similarity"]["score"], need, timing))
            candidates.sort(key=lambda c: -c["combined"])
            chosen = [c for c in candidates if c["priority"] == "A"]
            step("classify", "done", f"{len(chosen)} priority A, "
                 f"{sum(c['priority'] == 'B' for c in candidates)} B, {sum(c['priority'] == 'skip' for c in candidates)} skipped",
                 [{k: c[k] for k in ("account_id", "name", "need", "timing", "combined", "priority", "angle", "reason")}
                  | {"similarity": c["similarity"]["score"]} for c in candidates])

            current = "enrich"
            step("enrich", "running")
            enriched, now = [], datetime.now().isoformat(timespec="seconds")
            for c in chosen:
                contact, why = self.pick_contact(c["account_id"])
                enriched.append({"account": c["name"], "contact": contact and contact["name"], "role": contact and contact["role"],
                                 "why": why, "ok": contact is not None})
                c["contact"] = contact
                if contact is None:  # recorded, so the log shows the rule stopped it
                    self._write("INSERT INTO outreach (run_id, deal_id, account_id, contact_id, subject, body, status, "
                                "reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                                (run.id, deal["id"], c["account_id"], None, "", "", "blocked", f"Not drafted: {why}.", now))
            left = max(0, DAILY_CAP - self.sent_today())
            ready = [c for c in chosen if c["contact"]]
            step("enrich", "done", f"{len(ready)} with a contact who agreed · {left} of {DAILY_CAP} sends left today",
                 {"contacts": enriched, "sends_left_today": left, "daily_cap": DAILY_CAP})

            current = "email"
            step("email", "running")
            drafts = []
            for c in ready:
                if run.cancelled.is_set():
                    return
                contact = c["contact"]
                brief = (f"To: {contact['name']}, {contact['role']} at {c['name']} ({c['industry']}, {c['employees']} staff)\n"
                         f"What we know about them: {c['notes']}\nProof point: {win['proof_point']}\n"
                         f"Angle: {c['angle']}\nProblems similar companies have: {'; '.join(win.get('pains', []))}")
                tries, draft, problems = 0, {"subject": "", "body": ""}, ["not drafted"]
                while problems and tries < 2:
                    extra = "" if tries == 0 else ("\n\nYour last draft cannot be used: " + "; ".join(problems)
                                                   + ". Write it again, fixed.")
                    draft = self._call(model, EMAIL_SYSTEM, brief + extra, EMAIL_SCHEMA, charge)
                    problems = draft_problems(str(draft.get("subject", "")), str(draft.get("body", "")), names)
                    tries += 1
                body = str(draft.get("body", "")).strip() + "\n\n" + FOOTER
                status, reason = ("blocked", "Not shown for approval: " + "; ".join(problems) + ".") if problems else \
                                 ("draft", "Passed the checks" + (" on the second try." if tries == 2 else "."))
                row = self._write("INSERT INTO outreach (run_id, deal_id, account_id, contact_id, subject, body, status, "
                                  "reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                                  (run.id, deal["id"], c["account_id"], contact["id"], str(draft.get("subject", "")).strip(),
                                   body, status, reason, now))
                drafts.append(row)
                run.publish({"type": "draft", "id": row, "account": c["name"], "status": status})
            step("email", "done", f"{len(drafts)} drafted", {"drafts": len(drafts)})
            waiting = sum(1 for o in self.state()["outreach"] if o["run_id"] == run.id and o["status"] == "draft")
            step("approval", "running" if waiting else "done",
                 f"{waiting} waiting for you" if waiting else "Nothing to approve")
            run.publish({"type": "done", "drafts": waiting, "cost_usd": round(cost, 6), **self.state()})
        except ApiError as exc:
            step(current, "failed", exc.message)
            run.publish({"type": "error", "message": exc.message, "cost_usd": round(cost, 6)})

    # ----- the person's decision -----

    def decide(self, outreach_id: int, approve: bool) -> dict[str, Any]:
        """Approve (send, simulated) or reject a draft. Every rule is checked again here before anything is sent."""
        rows = self._rows("SELECT * FROM outreach WHERE id = ?", (outreach_id,))
        if not rows:
            raise ApiError(404, "not_found", "There is no draft with that id.")
        row = rows[0]
        if row["status"] != "draft":
            raise ApiError(409, "already_decided", f"That draft is already {row['status']}.")
        now = datetime.combine(self.today(), datetime.now().time()).isoformat(timespec="seconds")
        if not approve:
            self._write("UPDATE outreach SET status = 'rejected', reason = 'Rejected by you.', decided_at = ? WHERE id = ?",
                        (now, outreach_id))
            return {"sent": False, "message": "Rejected. Nothing was sent.", **self.state()}
        contact = self._rows("SELECT * FROM contacts WHERE id = ?", (row["contact_id"],))
        deal = self._rows("SELECT * FROM deals WHERE id = ?", (row["deal_id"],))[0]
        won = self._rows("SELECT * FROM accounts WHERE id = ?", (deal["account_id"],))[0]
        names = banned_names(won, self._rows("SELECT name FROM contacts WHERE account_id = ?", (won["id"],)))
        problem = None
        if not contact or not contact[0]["consent"] or contact[0]["unsubscribed"]:
            problem = "the contact has not agreed to email, or has unsubscribed since the draft was written"
        elif named(f"{row['subject']}\n{row['body']}", names):
            problem = "the email names the customer whose deal was won"
        if problem:
            self._write("UPDATE outreach SET status = 'blocked', reason = ?, decided_at = ? WHERE id = ?",
                        (f"Not sent: {problem}.", now, outreach_id))
            raise ApiError(409, "rule_broken", f"Not sent: {problem}.")
        if self.sent_today() >= DAILY_CAP:  # the draft stays, to approve tomorrow
            raise ApiError(409, "cap_reached", f"Not sent: today's limit of {DAILY_CAP} emails has been reached. "
                                               "The draft is kept; approve it tomorrow.")
        self._write("UPDATE outreach SET status = 'sent', reason = 'Approved by you. Sending is simulated.', "
                    "decided_at = ? WHERE id = ?", (now, outreach_id))
        return {"sent": True, "message": "Approved. Sending is simulated: the email is recorded, not delivered.",
                **self.state()}

    def set_consent(self, contact_id: str, consent: bool) -> dict[str, Any]:
        """Changes whether a contact has agreed to email, to try the rule that is checked again at approval."""
        if not self._rows("SELECT id FROM contacts WHERE id = ?", (contact_id,)):
            raise ApiError(404, "not_found", "There is no contact with that id.")
        self._write("UPDATE contacts SET consent = ? WHERE id = ?", (1 if consent else 0, contact_id))
        return self.contacts()

    def contacts(self) -> dict[str, Any]:
        return {"contacts": self._rows(
            "SELECT c.id, c.name, c.role, c.consent, c.unsubscribed, a.name AS account FROM contacts c "
            "JOIN accounts a ON a.id = c.account_id ORDER BY a.name, c.seniority DESC")}
