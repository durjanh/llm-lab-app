"""A digital teammate: an AI agent with its own identity in an invented team chat, after the agents Microsoft described
for Teams in November 2026, simulated here without Teams or its SDK.

People @mention the agent in a channel. It answers in a thread, showing each step as it works, and every tool call is
recorded under its own name in an audit log. An admin turns it on or off, decides which records it may read, and allows
or stops posts it makes on its own. A thread is the boundary of a conversation: a follow-up carries that thread only.

The model reads the records through tools and writes the recommendation. Code does the rest: the access checks, the
supplier rules, every sum (coverage, gap, cost), the check that each number and citation in a reply comes from a record
the agent read, the owners of each open requirement, and the daily limit on posts it makes on its own. The team
decides; nothing is ordered. The company, its suppliers and its people are invented.
"""
from __future__ import annotations

import json
import logging
import re
import sqlite3
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterator

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, text_of
from .history import assistant_blocks
from .runs import Run, RunStreamer
from .spend import SpendTracker

COMPANY = "Fernhill Moulding"
AGENT_NAME = "Sourcing Analyst"
MENTION = f"@{AGENT_NAME}"
YOU = "Anika Shah"
AGENT: dict[str, str] = {
    "name": AGENT_NAME, "kind": "AI agent", "email": "sourcing.analyst@fernhill.example", "handle": "sourcinganalyst",
    "id": "agent-5c1e9a20", "company": COMPANY, "owner": "Grace Whitfield", "reports_to": "Grace Whitfield",
    "reports_to_role": "Head of Procurement", "does": "Compares suppliers when the team needs more capacity",
}
PEOPLE = [
    {"name": YOU, "role": "Production Planner", "you": True},
    {"name": "Grace Whitfield", "role": "Head of Procurement", "you": False},
    {"name": "Tom Kerr", "role": "Quality Lead", "you": False},
]

MAX_CALLS = 16  # model calls in one answer: a small model often reads one record per call
MAX_REJECTED = 2  # replies code turns back before the answer fails
MAX_COVERAGE_CHECKS = 4  # shortlists it may try in one answer, so it chooses instead of searching for ever
MAX_SUMMARY_WORDS = 130
MAX_TOKENS = 4000  # room for a local model that thinks before it writes the reply; a cap, not a cost
PROACTIVE_DAILY_LIMIT = 2
NUDGE_WINDOW_DAYS = 7  # an open requirement due within this many days, or overdue, earns a nudge

# The records the agent may be allowed to read: what an admin grants or withholds.
SCOPES: dict[str, str] = {
    "demand": "Demand plan and internal capacity",
    "suppliers": "Supplier capacity and prices",
    "quality": "Quality records",
    "contracts": "Contracts and open requirements",
}

DEMAND = {"product": "PX-40 sensor housings", "quarter": "Q1 2027", "batches_needed": 30, "internal_batches": 12,
          "need_by_weeks": 6}

# id, name, batches offered for the quarter, price per batch (GBP), lead time (weeks), production sites
SUPPLIERS = [
    ("S1", "Brackenridge Plastics", 14, 4200, 5, 2),
    ("S2", "Cobalt Polymers", 10, 3800, 4, 1),
    ("S3", "Hartley Mouldings", 20, 3500, 7, 2),
    ("S4", "Vantage Industrial", 6, 4600, 3, 2),
]
# supplier, ISO 9001 valid until, defects (parts per million), deliveries on time (%)
QUALITY = {
    "S1": ("2027-08-31", 320, 96), "S2": ("2027-03-31", 410, 92),
    "S3": ("2026-09-30", 780, 84), "S4": ("2028-01-31", 150, 98),
}
# supplier, agreement, open requirements as (what, owner, due in days from the day the data is set up)
CONTRACTS = {
    "S1": ("Framework agreement signed", [("Sign the tooling transfer agreement", "Grace Whitfield", 9)]),
    "S2": ("No agreement yet", [("Onboard the supplier and sign an NDA", "Grace Whitfield", 7),
                                ("Get a continuity plan for its single site", "Tom Kerr", 14)]),
    "S3": ("Framework agreement signed", []),
    "S4": ("Framework agreement signed", [("First-article inspection", "Tom Kerr", 2)]),
}
MAX_DEFECT_PPM, MIN_ON_TIME = 500, 90

# Every record a reply may cite, by id.
DOCS: dict[str, str] = {"DOC-01": f"{DEMAND['quarter']} demand plan", "DOC-02": "Internal capacity schedule",
                        "DOC-10": "Supplier capacity returns"}
for _i, (_s, _n, *_r) in enumerate(SUPPLIERS, start=1):
    DOCS[f"DOC-2{_i}"] = f"{_n}: quality record"
    DOCS[f"DOC-3{_i}"] = f"{_n}: contract file"
QUALITY_DOC = {s[0]: f"DOC-2{i}" for i, s in enumerate(SUPPLIERS, start=1)}
CONTRACT_DOC = {s[0]: f"DOC-3{i}" for i, s in enumerate(SUPPLIERS, start=1)}

RULES = [
    "The agent reads only the records an admin has granted, checked at every tool call, and every call is logged "
    "under its own name.",
    f"A supplier may be shortlisted only with a current ISO 9001 certificate, at most {MAX_DEFECT_PPM} defects per "
    f"million, at least {MIN_ON_TIME}% on time, and a lead time within the {DEMAND['need_by_weeks']} weeks we have, "
    "and only after the agent has read its quality record.",
    "A shortlist may not ask a supplier for more than it offered or cover more than the gap, and one that leaves part "
    "of the gap must say how much.",
    "Every number in a reply must come from a record the agent read or a sum code worked out, and every citation from "
    "a record it read.",
    f"The agent posts on its own at most {PROACTIVE_DAILY_LIMIT} times a day, and only when an admin allows it.",
    "Coverage, gap and cost are worked out by code, and the decision stays with the team.",
]

SAMPLES = [
    f"{MENTION} we're {DEMAND['batches_needed'] - DEMAND['internal_batches']} batches short on PX-40 housings for "
    "Q1. Who should we shortlist?",
    f"{MENTION} Hartley is the cheapest. Why not just give them the whole gap?",
    f"{MENTION} what is still open before we can commit to a shortlist?",
]

SCHEMA_SQL = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE threads (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, author TEXT, kind TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, at TEXT, author TEXT, role TEXT,
                       text TEXT, data TEXT);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, actor TEXT, thread_id INTEGER, kind TEXT,
                    name TEXT, detail TEXT, outcome TEXT);
"""

TOOLS: list[dict[str, Any]] = [
    {"name": "read_demand_plan", "description": "The quarter's demand, our own capacity and the shortfall to cover.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "list_suppliers", "description": "Each supplier's id, the batches it offered for the quarter, its price "
     "per batch, lead time and number of sites.", "input_schema": {"type": "object", "properties": {}}},
    {"name": "read_quality_record", "description": "One supplier's ISO 9001 certificate, defect rate and on-time "
     "deliveries, with code's verdict on the quality rules.",
     "input_schema": {"type": "object", "properties": {"supplier_id": {"type": "string"}}, "required": ["supplier_id"]}},
    {"name": "read_contract", "description": "One supplier's agreement and the open requirements, each with its owner "
     "and due date.",
     "input_schema": {"type": "object", "properties": {"supplier_id": {"type": "string"}}, "required": ["supplier_id"]}},
    {"name": "check_coverage", "description": "Code works out what a possible shortlist covers: batches, the gap left, "
     "the cost, and whether each supplier passes the rules. Use it for every sum.",
     "input_schema": {"type": "object", "properties": {"allocations": {"type": "array", "items": {
         "type": "object", "properties": {"supplier_id": {"type": "string"}, "batches": {"type": "integer"}},
         "required": ["supplier_id", "batches"]}}}, "required": ["allocations"]}},
    {"name": "post_reply", "description": "Posts your answer in the thread. Code checks it first and sends it back if "
     "a rule is broken. Call it once, at the end.",
     "input_schema": {"type": "object", "properties": {
         "summary": {"type": "string", "description": f"At most {MAX_SUMMARY_WORDS} words, plain prose."},
         "shortlist": {"type": "array", "description": "Suppliers to shortlist, each with the batches to ask it for. "
                       "Empty when you cannot recommend any.", "items": {"type": "object", "properties": {
                           "supplier_id": {"type": "string"}, "batches": {"type": "integer"},
                           "why": {"type": "string"}}, "required": ["supplier_id", "batches", "why"]}},
         "citations": {"type": "array", "items": {"type": "string"},
                       "description": "The doc ids of the records your answer rests on."}},
         "required": ["summary", "shortlist", "citations"]}},
]
TOOL_SCOPE = {"read_demand_plan": "demand", "list_suppliers": "suppliers", "read_quality_record": "quality",
              "read_contract": "contracts"}
STEP_LABELS = {"read_demand_plan": "Read the demand plan", "list_suppliers": "Listed the suppliers' offers",
               "read_quality_record": "Read the quality record: {name}", "read_contract": "Read the contract file: {name}",
               "check_coverage": "Worked out coverage (code)"}

SYSTEM = f"""You are {AGENT_NAME}, an AI agent at {COMPANY}, a maker of plastic parts. You work in the procurement
team's channel under your own account, and people @mention you to compare suppliers when they need more capacity.

Work through your tools: read the demand plan, list the suppliers, read the quality record of any supplier you might
shortlist and its contract file for open requirements, then use check_coverage for every sum. You may call several
tools at once. When check_coverage shows a shortlist you are happy with, end by calling post_reply once.
- Shortlist only suppliers whose quality record you read and that pass the rules. Ask each for no more than it offered,
  and cover the gap without going over it. Prefer fewer suppliers, then lower cost, but say when a supplier has a single
  site or open requirements.
- Use only numbers from your tool results. Cite the doc ids of the records you relied on.
- If you were refused access to a record, say what you could not check. Do not guess what it says.
- You recommend; the team decides. Never say an order has been placed.
- Plain British English. No headings or bullet points in the summary: code adds the table and the checklist."""

NUDGE_SCHEMA: dict[str, Any] = {"type": "object", "additionalProperties": False, "required": ["text"],
                                "properties": {"text": {"type": "string"}}}
NUDGE_SYSTEM = f"""You are {AGENT_NAME}, an AI agent in {COMPANY}'s procurement channel. Write one short message (at
most 60 words) that follows up on the open requirements listed, so the work does not stall. Name each owner with an
@ before their name and say what is waiting on them and when it is due. Friendly, plain British English. Answer as JSON."""

_NUM = re.compile(r"\d+(?:\.\d+)?")
log = logging.getLogger("llm_lab")


def mentions_agent(text: str) -> bool:
    """Whether a post @mentions the agent, by its name or its handle."""
    low = text.lower()
    return MENTION.lower() in low or f"@{AGENT['handle']}" in low


def states_shortfall(summary: str, short: int) -> bool:
    """Whether the summary says how many batches are still short, not just mentions the number somewhere."""
    n = rf"(?<![\d.]){short}(?![\d.])"
    words = r"(?:short|uncovered|remaining|outstanding|left over|still needed|missing)"
    return bool(re.search(rf"{n}(?:\W+\w+){{0,3}}?\W+{words}\b|\b(?:shortfall|short|gap)\W+(?:\w+\W+){{0,2}}?{n}",
                          summary, re.I))


def numbers_in(text: str) -> set[str]:
    """The numbers in a text, written the same way whatever the commas or leading zeros: "£4,200" and "4200" match.
    Only a comma followed by three digits is a thousands separator, so "6,8" stays two numbers."""
    found = set()
    for n in _NUM.findall(re.sub(r"(?<=\d),(?=\d{3}(?!\d))", "", text)):
        whole, _, frac = n.partition(".")
        whole = whole.lstrip("0") or "0"
        frac = frac.rstrip("0")
        found.add(f"{whole}.{frac}" if frac else whole)
    return found


def _words(text: str) -> int:
    return len(re.findall(r"\b[\w'’-]+\b", text))


def supplier(sid: str) -> dict[str, Any] | None:
    for s in SUPPLIERS:
        if s[0] == sid:
            return {"supplier_id": s[0], "name": s[1], "batches_offered": s[2], "price_per_batch_gbp": s[3],
                    "lead_time_weeks": s[4], "sites": s[5]}
    return None


def quality_check(sid: str, today: date) -> dict[str, Any]:
    """Whether a supplier passes the quality and timing rules, and why not. Code's verdict, not the model's."""
    s = supplier(sid)
    if s is None:
        return {"passes": False, "fails": ["no such supplier"]}
    valid_until, ppm, on_time = QUALITY[sid]
    fails = []
    if date.fromisoformat(valid_until) < today:
        fails.append(f"ISO 9001 certificate lapsed on {valid_until}")
    if ppm > MAX_DEFECT_PPM:
        fails.append(f"{ppm} defects per million; the limit is {MAX_DEFECT_PPM}")
    if on_time < MIN_ON_TIME:
        fails.append(f"{on_time}% on time; the minimum is {MIN_ON_TIME}%")
    if s["lead_time_weeks"] > DEMAND["need_by_weeks"]:
        fails.append(f"{s['lead_time_weeks']}-week lead time; we need the parts within {DEMAND['need_by_weeks']} weeks")
    return {"passes": not fails, "fails": fails}


def gap() -> int:
    return DEMAND["batches_needed"] - DEMAND["internal_batches"]


def coverage(allocations: list[dict[str, Any]], internal: int | None, today: date) -> dict[str, Any]:
    """What a shortlist covers: batches, the gap left, the cost, and each supplier's rules. The widget and the agent's
    check_coverage tool both come here, so the sums on the page and in a reply are the same sums."""
    internal = DEMAND["internal_batches"] if internal is None else internal
    rows, total, cost, problems = [], 0, 0, []
    for a in allocations:
        s = supplier(str(a.get("supplier_id", "")))
        if s is None:
            problems.append(f"there is no supplier {a.get('supplier_id')!r}")
            continue
        batches = int(a.get("batches", 0) or 0)
        if batches <= 0:
            continue
        over = max(0, batches - s["batches_offered"])
        if over:
            problems.append(f"{s['name']} offered {s['batches_offered']} batches, not {batches}")
        q = quality_check(s["supplier_id"], today)
        rows.append({"supplier_id": s["supplier_id"], "name": s["name"], "batches": batches,
                     "cost_gbp": batches * s["price_per_batch_gbp"], "passes_rules": q["passes"], "fails": q["fails"],
                     "single_site": s["sites"] == 1})
        total += batches
        cost += batches * s["price_per_batch_gbp"]
    covered = internal + total
    return {"batches_needed": DEMAND["batches_needed"], "internal_batches": internal, "from_suppliers": total,
            "covered": covered, "gap_left": max(0, DEMAND["batches_needed"] - covered),
            "over_by": max(0, covered - DEMAND["batches_needed"]), "cost_gbp": cost, "rows": rows, "problems": problems}


class TeammateService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, root: Path, streamer: RunStreamer | None = None,
                 today: Callable[[], date] = date.today):
        self.claude, self.spend, self.root, self.streamer, self.today = claude, spend, root, streamer, today
        self.path = root / "teammate.db"
        self._lock = threading.RLock()
        self._busy: set[int] = set()  # threads the agent is answering now
        self._reserved = 0  # posts of its own being written now, counted against the day's limit

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
            db.executemany("INSERT INTO meta VALUES (?, ?)", [
                ("seeded_on", self.today().isoformat()), ("enabled", "1"), ("scopes", json.dumps(list(SCOPES))),
                ("proactive", "1")])
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

    def _now(self) -> str:
        return datetime.combine(self.today(), datetime.now().time()).isoformat(timespec="seconds")

    def settings(self) -> dict[str, Any]:
        meta = {r["key"]: r["value"] for r in self._rows("SELECT key, value FROM meta")}
        return {"enabled": meta.get("enabled") == "1", "scopes": [s for s in json.loads(meta.get("scopes", "[]"))
                                                                   if s in SCOPES],
                "proactive": meta.get("proactive") == "1", "seeded_on": meta.get("seeded_on", self.today().isoformat())}

    def _audit(self, actor: str, thread_id: int | None, kind: str, name: str, detail: Any, outcome: str) -> None:
        text = detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)
        self._write("INSERT INTO audit (at, actor, thread_id, kind, name, detail, outcome) VALUES (?,?,?,?,?,?,?)",
                    (self._now(), actor, thread_id, kind, name, text[:400], outcome))

    def _post(self, thread_id: int, author: str, role: str, text: str, data: Any = None) -> int:
        return self._write("INSERT INTO messages (thread_id, at, author, role, text, data) VALUES (?,?,?,?,?,?)",
                           (thread_id, self._now(), author, role, text, json.dumps(data) if data is not None else None))

    def _requirements(self, sid: str) -> list[dict[str, Any]]:
        start = date.fromisoformat(self.settings()["seeded_on"])
        return [{"what": what, "owner": owner, "due": (start + timedelta(days=days)).isoformat()}
                for what, owner, days in CONTRACTS[sid][1]]

    # ----- what the page shows -----

    def info(self) -> dict[str, Any]:
        return {"agent": AGENT, "people": PEOPLE, "you": YOU, "company": COMPANY, "mention": MENTION, "rules": RULES,
                "scopes": SCOPES, "samples": SAMPLES, "docs": DOCS, "model": DEFAULT_MODEL,
                "proactive_daily_limit": PROACTIVE_DAILY_LIMIT, "demand": {**DEMAND, "gap": gap()},
                "suppliers": [supplier(s[0]) for s in SUPPLIERS],
                "tools": [{"name": t["name"], "scope": TOOL_SCOPE.get(t["name"]), "does": t["description"]}
                          for t in TOOLS]}

    def coverage(self, allocations: list[dict[str, Any]], internal: int | None) -> dict[str, Any]:
        return coverage(allocations, internal, self.today())

    def proactive_today(self) -> int:
        return self._rows("SELECT COUNT(*) AS n FROM threads WHERE kind = 'proactive' AND substr(created_at, 1, 10) = ?",
                          (self.today().isoformat(),))[0]["n"]

    def state(self) -> dict[str, Any]:
        threads = self._rows("SELECT * FROM threads ORDER BY id DESC")
        messages = self._rows("SELECT * FROM messages ORDER BY id")
        by_thread: dict[int, list[dict]] = {}
        for m in messages:
            m["data"] = json.loads(m["data"]) if m["data"] else None
            by_thread.setdefault(m["thread_id"], []).append(m)
        with self._lock:
            busy = sorted(self._busy)
        # A thread whose stream was dropped before its first post was written has no messages: it is not shown.
        return {"threads": [{**t, "messages": by_thread[t["id"]], "busy": t["id"] in busy} for t in threads
                            if t["id"] in by_thread],
                "settings": self.settings(), "audit": self._rows("SELECT * FROM audit ORDER BY id DESC LIMIT 200"),
                "proactive": {"today": self.proactive_today(), "limit": PROACTIVE_DAILY_LIMIT}}

    def reset(self) -> dict[str, Any]:
        """Puts the channel back as it started: no threads, no log, the agent on with every record granted."""
        with self._lock:
            if self._busy or self._reserved:
                raise ApiError(409, "busy", f"{AGENT_NAME} is answering. Reset when it has finished.")
            self._seed()
        return self.state()

    # ----- the admin's controls -----

    def admin(self, enabled: bool | None, scopes: list[str] | None, proactive: bool | None) -> dict[str, Any]:
        """Turns the agent on or off, sets which records it may read, and allows or stops posts of its own. Each
        change is logged. A change applies from the agent's next tool call, even in the middle of an answer."""
        if scopes is not None and (bad := [s for s in scopes if s not in SCOPES]):
            raise ApiError(400, "bad_scope", f"Unknown record type: {', '.join(bad)}.")
        changes = []
        with self._lock:
            current = self.settings()
            if enabled is not None and enabled != current["enabled"]:
                self._write("UPDATE meta SET value = ? WHERE key = 'enabled'", ("1" if enabled else "0",))
                changes.append(("Turned the agent " + ("on" if enabled else "off"), ""))
            if scopes is not None and sorted(set(scopes)) != sorted(current["scopes"]):
                kept = [s for s in SCOPES if s in scopes]
                self._write("UPDATE meta SET value = ? WHERE key = 'scopes'", (json.dumps(kept),))
                granted = sorted(set(kept) - set(current["scopes"]))
                withdrawn = sorted(set(current["scopes"]) - set(kept))
                changes.append(("Changed what it may read", "; ".join(
                    [f"granted {SCOPES[s]}" for s in granted] + [f"withdrew {SCOPES[s]}" for s in withdrawn])))
            if proactive is not None and proactive != current["proactive"]:
                self._write("UPDATE meta SET value = ? WHERE key = 'proactive'", ("1" if proactive else "0",))
                changes.append(("Posts of its own " + ("allowed" if proactive else "stopped"), ""))
        for name, detail in changes:
            self._audit("Admin (you)", None, "admin", name, detail, "done")
        return self.state()

    # ----- the agent at work -----

    def _claim(self, thread_id: int) -> bool:
        with self._lock:
            if thread_id in self._busy:
                return False
            self._busy.add(thread_id)
            return True

    def _release(self, thread_id: int) -> None:
        with self._lock:
            self._busy.discard(thread_id)

    def mention(self, text: str, model: str | None) -> Iterator[str]:
        """A new post in the channel. The agent answers in its thread when the post @mentions it, and streams the
        steps as NDJSON; a post that does not mention it is just posted."""
        text = self._checked_text(text)
        thread_id = self._write("INSERT INTO threads (created_at, author, kind) VALUES (?,?,?)",
                                (self._now(), YOU, "mention"))
        return self._stream(thread_id, text, model or DEFAULT_MODEL, mentioned=mentions_agent(text))

    def reply(self, thread_id: int, text: str, model: str | None) -> Iterator[str]:
        """A follow-up in a thread. Only that thread's messages go with it, so each thread is its own conversation."""
        text = self._checked_text(text)
        if not self._rows("SELECT id FROM threads WHERE id = ?", (thread_id,)):
            raise ApiError(404, "not_found", "There is no thread with that id.")
        with self._lock:
            if thread_id in self._busy:  # checked here for a clear answer; the claim in the work is what counts
                raise ApiError(409, "busy", f"{AGENT_NAME} is still answering in this thread.")
        return self._stream(thread_id, text, model or DEFAULT_MODEL, mentioned=True)

    def _checked_text(self, text: str) -> str:
        text = text.strip()
        if not text:
            raise ApiError(400, "empty", "Write a message first.")
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        return text

    def _stream(self, thread_id: int, text: str, model: str, mentioned: bool) -> Iterator[str]:
        """Runs the work in the background. The thread is claimed inside the work, so a stream that never starts
        cannot leave it marked busy, and two answers can never run in one thread."""
        run = Run()

        def work() -> None:
            if not self._claim(thread_id):
                run.publish({"type": "error", "message": f"{AGENT_NAME} is still answering in this thread.",
                             "cost_usd": 0})
                return
            try:
                if not self._rows("SELECT id FROM threads WHERE id = ?", (thread_id,)):
                    run.publish({"type": "error", "message": "The channel was reset; that thread is gone.",
                                 "cost_usd": 0})
                    return
                self._post(thread_id, YOU, "person", text)
                run.publish({"type": "thread", "thread_id": thread_id})
                if mentioned:
                    self._answer(run, thread_id, text, model)
                else:
                    run.publish({"type": "done", "cost_usd": 0, "note": f"Posted. {AGENT_NAME} joins a conversation "
                                 "only when it is @mentioned.", **self.state()})
            finally:
                self._release(thread_id)

        assert self.streamer is not None
        return self.streamer.lines(run, work)

    def _history(self, thread_id: int, latest: str) -> tuple[str, set[str]]:
        """The thread so far as one prompt, and the numbers in it the agent may repeat."""
        earlier = self._rows("SELECT author, role, text, data FROM messages WHERE thread_id = ? AND role != 'system' "
                             "ORDER BY id", (thread_id,))[:-1]  # the last one is the new message
        lines, nums = [], numbers_in(latest)
        for m in earlier:
            line = m["text"]
            if m["data"]:
                data = json.loads(m["data"])
                rows = "; ".join(f"{r['name']} {r['batches']} batches" for r in data.get("shortlist", []))
                if rows:
                    line += f" (Shortlist: {rows}.)"
            lines.append(f"- {m['author']}: {line}")
            nums |= numbers_in(line)
        prompt = (f"Earlier in this thread:\n" + "\n".join(lines) + "\n\n") if lines else ""
        return prompt + f"New message from {YOU} ({PEOPLE[0]['role']}): {latest}", nums

    def _tool(self, name: str, args: dict[str, Any], thread_id: int, seen: dict[str, Any]) -> dict[str, Any]:
        """Runs one tool call, if the admin allows it now, and logs it under the agent's name."""
        settings = self.settings()
        if not settings["enabled"]:
            seen["stopped"] = True
            self._audit(AGENT_NAME, thread_id, "tool", name, args, "refused: agent turned off")
            return {"error": "An admin has turned this agent off. Stop now."}
        scope = TOOL_SCOPE.get(name)
        if scope and scope not in settings["scopes"]:
            seen["denied"].add(scope)
            self._audit(AGENT_NAME, thread_id, "tool", name, args, f"denied: no access to {SCOPES[scope].lower()}")
            return {"error": f"Access denied: an admin has not granted you {SCOPES[scope].lower()}."}
        today = self.today()
        sid = str(args.get("supplier_id", ""))
        out: dict[str, Any]
        if name == "read_demand_plan":
            out = {**DEMAND, "shortfall_batches": gap(), "docs": ["DOC-01", "DOC-02"]}
        elif name == "list_suppliers":
            out = {"suppliers": [supplier(s[0]) for s in SUPPLIERS], "docs": ["DOC-10"]}
        elif name in ("read_quality_record", "read_contract") and supplier(sid) is None:
            out = {"error": f"There is no supplier {sid!r}. The ids are {', '.join(s[0] for s in SUPPLIERS)}."}
        elif name == "read_quality_record":
            valid_until, ppm, on_time = QUALITY[sid]
            q = quality_check(sid, today)
            out = {"supplier_id": sid, "name": supplier(sid)["name"], "iso_9001_valid_until": valid_until,
                   "defects_per_million": ppm, "on_time_percent": on_time, "passes_rules": q["passes"],
                   "fails": q["fails"], "docs": [QUALITY_DOC[sid]]}
            seen["quality"].add(sid)
        elif name == "read_contract":
            out = {"supplier_id": sid, "name": supplier(sid)["name"], "agreement": CONTRACTS[sid][0],
                   "open_requirements": self._requirements(sid), "docs": [CONTRACT_DOC[sid]]}
            seen["contracts"].add(sid)
        elif name == "check_coverage" and seen["checks"] >= MAX_COVERAGE_CHECKS:
            out = {"error": f"You have used your {MAX_COVERAGE_CHECKS} coverage checks. Choose the best shortlist you "
                            "have checked and call post_reply now."}
        elif name == "check_coverage":
            seen["checks"] += 1
            allocations = args.get("allocations") if isinstance(args.get("allocations"), list) else []
            out = coverage([a for a in allocations if isinstance(a, dict)], None, today)
            if not out["gap_left"] and not out["over_by"] and not out["problems"] and all(
                    r["passes_rules"] for r in out["rows"]):
                out["note"] = "This covers the gap exactly and every supplier passes the rules."
            out["checks_left"] = MAX_COVERAGE_CHECKS - seen["checks"]
        else:
            out = {"error": f"There is no tool called {name}."}
        if "error" not in out:
            seen["docs"].update(out.get("docs", []))
            seen["numbers"] |= numbers_in(json.dumps(out))
        self._audit(AGENT_NAME, thread_id, "tool", name, args, "error" if "error" in out else "ok")
        return out

    def check_reply(self, reply: dict[str, Any], seen: dict[str, Any]) -> list[str]:
        """Why a reply may not be posted, or nothing when it may. Each problem goes back to the model to fix."""
        problems = []
        summary = str(reply.get("summary", "")).strip()
        shortlist = reply.get("shortlist") if isinstance(reply.get("shortlist"), list) else []
        citations = reply.get("citations") if isinstance(reply.get("citations"), list) else []
        if not summary:
            problems.append("the summary is empty")
        elif _words(summary) > MAX_SUMMARY_WORDS:
            problems.append(f"the summary is {_words(summary)} words; the limit is {MAX_SUMMARY_WORDS}")
        total, ids = 0, set()
        for item in shortlist:
            sid = str(item.get("supplier_id", "")) if isinstance(item, dict) else ""
            s = supplier(sid)
            if s is None:
                problems.append(f"the shortlist names {sid!r}, which is not a supplier")
                continue
            if sid in ids:
                problems.append(f"{s['name']} is on the shortlist twice")
            ids.add(sid)
            try:
                batches = int(item.get("batches", 0))
            except (TypeError, ValueError):
                batches = 0
            if batches <= 0:
                problems.append(f"{s['name']} is shortlisted for {item.get('batches')!r} batches")
            elif batches > s["batches_offered"]:
                problems.append(f"{s['name']} offered {s['batches_offered']} batches, not {batches}")
            total += max(0, batches)
            if sid not in seen["quality"]:
                problems.append(f"{s['name']} is shortlisted but you have not read its quality record")
            elif not (q := quality_check(sid, self.today()))["passes"]:
                problems.append(f"{s['name']} fails the rules ({'; '.join(q['fails'])}) and may not be shortlisted")
        if total > gap():
            problems.append(f"the shortlist asks for {total} batches; the gap is {gap()}")
        elif shortlist and total < gap() and not states_shortfall(summary, gap() - total):
            problems.append(f"the shortlist covers {total} of the {gap()}-batch gap, so {gap() - total} are still "
                            "short; cover the gap, or say in the summary how many are still short")
        unread = [str(c) for c in citations if str(c) not in seen["docs"]]
        if unread:
            problems.append(f"it cites {', '.join(unread)}, which you did not read in this answer")
        if shortlist and not citations:
            problems.append("a shortlist needs the doc ids of the records it rests on")
        allowed = seen["numbers"] | {str(n) for n in range(11)}
        for item in shortlist:
            if isinstance(item, dict):
                allowed |= numbers_in(str(item.get("batches", "")))
        stray = sorted(numbers_in(summary + " " + " ".join(str(i.get("why", "")) for i in shortlist
                                                           if isinstance(i, dict))) - allowed, key=float)
        if stray:
            problems.append(f"it gives {', '.join(stray)}, which is in no record you read and no sum code worked "
                            "out; use check_coverage for sums, and only numbers from your tool results")
        return problems

    def _answer(self, run: Run, thread_id: int, question: str, model: str) -> None:
        cost = 0.0
        steps: list[dict[str, str]] = []

        def step(label: str, status: str, detail: str = "", index: int | None = None) -> int:
            if index is None:
                steps.append({"label": label, "status": status, "detail": detail})
                index = len(steps) - 1
            else:
                steps[index] = {"label": label, "status": status, "detail": detail}
            run.publish({"type": "step", "thread_id": thread_id, "index": index, **steps[index]})
            return index

        def fail(message: str) -> None:
            step("Stopped", "failed", message)
            self._post(thread_id, AGENT_NAME, "system", f"{AGENT_NAME} could not answer: {message}",
                       {"steps": steps})
            self._audit(AGENT_NAME, thread_id, "message", "answer failed", message, "failed")
            run.publish({"type": "error", "message": message, "cost_usd": round(cost, 6), **self.state()})

        if not self.settings()["enabled"]:  # code answers, no model call
            self._post(thread_id, AGENT_NAME, "system", f"{AGENT_NAME} is turned off by your admin, so it cannot "
                       "answer. Turn it on in the admin centre.")
            self._audit(AGENT_NAME, thread_id, "message", "mention while turned off", "", "refused")
            run.publish({"type": "done", "cost_usd": 0, **self.state()})
            return

        prompt, history_numbers = self._history(thread_id, question)
        seen: dict[str, Any] = {"docs": set(), "numbers": set(history_numbers), "quality": set(), "contracts": set(),
                                "denied": set(), "stopped": False, "checks": 0}
        messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
        rejected, nudged = 0, False
        thinking = step("Reading the question", "running")
        try:
            for _ in range(MAX_CALLS):
                if run.cancelled.is_set():
                    return
                try:
                    response = self.claude.create(model=model, max_tokens=MAX_TOKENS, system=SYSTEM, tools=TOOLS,
                                                  messages=messages)
                except Exception as exc:
                    raise to_api_error(exc) from exc
                cost += self.spend.charge(response, model) or 0.0
                if thinking is not None:
                    step("Read the question", "done", index=thinking)
                    thinking = None
                stop = getattr(response, "stop_reason", None)
                if stop == "refusal":
                    raise ApiError(422, "refused", "The model declined to answer. Nothing was posted.")
                if stop == "max_tokens":
                    raise ApiError(502, "cut_off", "The model's reply was cut off before it finished. Nothing was "
                                                   "posted.")
                results, final, last_problems = [], None, []
                for block in response.content:
                    if getattr(block, "type", None) != "tool_use":
                        continue
                    args = dict(block.input) if isinstance(block.input, dict) else {}
                    if block.name == "post_reply" and not self.settings()["enabled"]:
                        seen["stopped"] = True  # turned off while the model was writing: the reply is not posted
                        self._audit(AGENT_NAME, thread_id, "tool", "post_reply", "", "refused: agent turned off")
                        continue
                    if block.name == "post_reply":
                        i = step("Checking the reply (code)", "running")
                        last_problems = self.check_reply(args, seen)
                        if last_problems:
                            rejected += 1
                            step("Reply sent back (code)", "failed", "; ".join(last_problems), index=i)
                            self._audit(AGENT_NAME, thread_id, "check", "reply sent back", "; ".join(last_problems),
                                        "sent back")
                            results.append({"type": "tool_result", "tool_use_id": block.id, "is_error": True,
                                            "content": "Not posted: " + "; ".join(last_problems) + ". Fix it and "
                                                       "call post_reply again."})
                        else:
                            step("Checked the reply (code)", "done", index=i)
                            final = args
                            results.append({"type": "tool_result", "tool_use_id": block.id, "content": "Posted."})
                        continue
                    sid = str(args.get("supplier_id", ""))
                    label = STEP_LABELS.get(block.name, block.name).format(
                        name=(supplier(sid) or {"name": sid or "?"})["name"])
                    i = step(label, "running")
                    out = self._tool(block.name, args, thread_id, seen)
                    if "error" in out:
                        step(f"{label}: refused", "failed", out["error"], index=i)
                    elif block.name == "check_coverage":
                        step(label, "done", " + ".join(f"{r['name']} {r['batches']}" for r in out["rows"])
                             + f": {out['covered']} of {out['batches_needed']} covered, {out['gap_left']} short"
                             + "".join(f"; {p}" for p in out["problems"]), index=i)
                    else:
                        step(label, "done", index=i)
                    results.append({"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(out),
                                    **({"is_error": True} if "error" in out else {})})
                if seen["stopped"]:
                    fail("an admin turned the agent off while it was working.")
                    return
                if final is not None:
                    self._publish_reply(run, thread_id, final, seen, steps, round(cost, 6))
                    return
                if rejected > MAX_REJECTED:
                    raise ApiError(502, "checks_failed", "The reply broke code's rules three times, so nothing was "
                                   "posted. Last problems: " + "; ".join(last_problems) + ".")
                messages = messages + [{"role": "assistant", "content": assistant_blocks(response)}]
                if not results:  # it answered in plain text: once, ask for post_reply
                    if nudged:
                        raise ApiError(502, "no_reply", "The model answered without posting through post_reply, so "
                                                        "code could not check it. Nothing was posted.")
                    nudged = True
                    messages.append({"role": "user", "content": "Post your answer with the post_reply tool, so code "
                                                                "can check it."})
                    continue
                messages.append({"role": "user", "content": results})
            raise ApiError(502, "too_long", f"The agent did not finish within {MAX_CALLS} model calls. Nothing was "
                                            "posted.")
        except ApiError as exc:
            fail(exc.message)
        except Exception:  # a bug or a database error: the thread still says what happened, then the run reports it
            log.exception("The digital teammate's answer failed.")
            try:
                fail("something went wrong on the server. Nothing was posted.")
            except Exception:
                log.exception("Could not record the failure either.")
                raise

    def _publish_reply(self, run: Run, thread_id: int, reply: dict[str, Any], seen: dict[str, Any],
                       steps: list[dict[str, str]], cost: float) -> None:
        """Posts a checked reply, with the table, the checklist and the citations built by code."""
        today = self.today()
        given = reply.get("shortlist") if isinstance(reply.get("shortlist"), list) else []
        shortlist = [{"supplier_id": str(i["supplier_id"]), "batches": int(i["batches"]), "why": str(i.get("why", ""))}
                     for i in given]  # check_reply has passed, so every item is a dict with a known id and batches
        cov = coverage(shortlist, None, today)
        rows = []
        for item, row in zip(shortlist, cov["rows"]):
            s = supplier(item["supplier_id"]) or {}
            rows.append({**row, "why": item["why"], "price_per_batch_gbp": s.get("price_per_batch_gbp"),
                         "lead_time_weeks": s.get("lead_time_weeks"),
                         "contract_checked": item["supplier_id"] in seen["contracts"]})
        checklist = []
        for item in shortlist:
            sid, name = item["supplier_id"], (supplier(item["supplier_id"]) or {}).get("name", item["supplier_id"])
            if sid in seen["contracts"]:
                checklist += [{"supplier": name, **r} for r in self._requirements(sid)]
            else:
                checklist.append({"supplier": name, "what": "Contract and open requirements not checked: "
                                  + ("no access" if "contracts" in seen["denied"] else "not read"), "owner": "",
                                  "due": ""})
            covered = sid in seen["contracts"] and any("continuity" in r["what"] for r in self._requirements(sid))
            if (supplier(sid) or {}).get("sites") == 1 and not covered:
                checklist.append({"supplier": name, "what": "Single production site: agree a continuity plan",
                                  "owner": "", "due": ""})
        cited = reply.get("citations") if isinstance(reply.get("citations"), list) else []
        citations = [{"id": c, "title": DOCS.get(c, c)} for c in dict.fromkeys(str(c) for c in cited)]
        steps.append({"label": "Posted in the thread", "status": "done", "detail": ""})
        data = {"shortlist": rows, "coverage": cov, "checklist": checklist, "citations": citations, "steps": steps,
                "not_checked": sorted(SCOPES[s] for s in seen["denied"])}
        self._post(thread_id, AGENT_NAME, "agent", str(reply["summary"]).strip(), data)
        self._audit(AGENT_NAME, thread_id, "message", "posted a reply",
                    f"{len(rows)} shortlisted, {len(citations)} citations", "ok")
        run.publish({"type": "done", "cost_usd": cost, **self.state()})

    # ----- posts of its own -----

    def morning_check(self, model: str | None) -> dict[str, Any]:
        """The agent's scheduled look at open requirements: it posts a nudge when one is due soon, within the admin's
        limits. Code picks what to nudge about and whom; the model only words it."""
        model = model or DEFAULT_MODEL
        settings = self.settings()
        if not settings["enabled"] or not settings["proactive"]:
            why = "the agent is turned off" if not settings["enabled"] else "posts of its own are stopped"
            self._audit(AGENT_NAME, None, "proactive", "morning check", why, "skipped")
            return {"posted": False, "message": f"Nothing posted: {why}.", "cost_usd": 0, **self.state()}
        shortlisted = self._shortlisted()
        today = self.today()
        due = [{"supplier": supplier(sid)["name"], **r} for sid in shortlisted for r in self._requirements(sid)
               if date.fromisoformat(r["due"]) <= today + timedelta(days=NUDGE_WINDOW_DAYS)]
        if not due:
            self._audit(AGENT_NAME, None, "proactive", "morning check", "nothing due soon on a shortlist", "skipped")
            return {"posted": False, "cost_usd": 0, **self.state(),
                    "message": "Nothing posted: no open requirement on a shortlisted supplier is due within "
                               f"{NUDGE_WINDOW_DAYS} days." if shortlisted else
                               "Nothing posted: nothing has been shortlisted yet, so nothing is waiting on anyone."}
        with self._lock:  # the day's limit is checked and a slot reserved together, so two checks cannot both pass
            if self.proactive_today() + self._reserved >= PROACTIVE_DAILY_LIMIT:
                limit_hit = True
            else:
                limit_hit = False
                self._reserved += 1
        if limit_hit:
            self._audit(AGENT_NAME, None, "proactive", "morning check", "daily limit reached", "skipped")
            return {"posted": False, "cost_usd": 0, **self.state(), "message": "Nothing posted: the agent has made "
                    f"its {PROACTIVE_DAILY_LIMIT} posts of its own today, the limit your admin set."}
        try:
            text, cost, worded_by = self._nudge_text(model, due, today)
            with self._lock:  # the thread and its post are written together, so the slot passes from reserved to used
                thread_id = self._write("INSERT INTO threads (created_at, author, kind) VALUES (?,?,?)",
                                        (self._now(), AGENT_NAME, "proactive"))
                self._post(thread_id, AGENT_NAME, "agent", text, {"nudge": due, "worded_by": worded_by})
        finally:
            with self._lock:  # released once, whether it was used or the work failed
                self._reserved -= 1
        self._audit(AGENT_NAME, thread_id, "proactive", "posted a follow-up",
                    "; ".join(f"{d['owner']}: {d['what']}" for d in due), "ok")
        return {"posted": True, "message": "Posted a follow-up in the channel.", "cost_usd": round(cost, 6),
                **self.state()}

    def _shortlisted(self) -> list[str]:
        """Suppliers on the latest shortlist the agent posted, in any thread. Earlier shortlists were replaced by it."""
        for m in self._rows("SELECT data FROM messages WHERE role = 'agent' AND data IS NOT NULL ORDER BY id DESC"):
            shortlist = json.loads(m["data"]).get("shortlist") or []
            if shortlist:
                return [r["supplier_id"] for r in shortlist]
        return []

    def _nudge_text(self, model: str, due: list[dict], today: date) -> tuple[str, float, str]:
        """The model's wording, if it names every owner and keeps to the length; code's own wording if not."""
        listing = "\n".join(f"- {d['what']} ({d['supplier']}), owner {d['owner']}, due {d['due']}" for d in due)
        try:
            response = self.claude.create(
                model=model, max_tokens=400, system=NUDGE_SYSTEM,
                messages=[{"role": "user", "content": f"Today is {today.isoformat()}.\nOpen requirements:\n{listing}"}],
                output_config={"format": {"type": "json_schema", "schema": NUDGE_SCHEMA}})
        except Exception as exc:
            raise to_api_error(exc) from exc
        cost = self.spend.charge(response, model) or 0.0
        try:
            text = str(json.loads(text_of(response)).get("text", "")).strip()
        except (json.JSONDecodeError, AttributeError):
            text = ""
        owners = {d["owner"] for d in due}
        if (text and all(f"@{o}".lower() in text.lower() for o in owners) and _words(text) <= 80
                and getattr(response, "stop_reason", None) not in ("refusal", "max_tokens")):
            return text, cost, "model"
        fallback = "Morning check: " + " ".join(f"@{d['owner']}, {d['what'].lower()} for {d['supplier']} is due "
                                                f"{d['due']}." for d in due)
        return fallback, cost, "code (the model's wording missed an owner or ran long)"
