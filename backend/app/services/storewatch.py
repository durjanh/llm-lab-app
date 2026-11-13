"""A shoplifting alert desk: behaviour alerts, a person's decision, a watchlist, and a check at the door.

Two sources feed it. The live desk watches a webcam or an uploaded clip: the browser finds people, poses and items and
applies rules in code (picked up, possible concealment, till, exit), and asks the behaviour model (on Azure OpenAI)
only when those rules raise suspicion, with a burst of frames and the local events as context. The scripted day uses
invented people. It runs as a demo on this machine: there is no gate to fill in before it works.
What stays enforced in this service, not on the page:

- A high behaviour score alerts the admin and holds the person for review. It never puts anyone on the live watchlist.
- Only a named person can confirm a theft, and only then can the door match them.
- A held face that nobody confirms is deleted. So is every live entry when its retention period ends.
- A visitor who matches nobody is compared and forgotten: nothing about them is stored.
- A door match is a possible match. Staff decide, and a wrong match is recorded.
- Evidence clips are files under generated/storewatch/clips, deleted with the alert's footage.
"""
from __future__ import annotations

import json
import math
import random
import re
import secrets
import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Protocol

from ..core.errors import ApiError
from ..gateways.azure_openai import StructuredModel
from .spend import SpendTracker

HIGH_SCORE = 90  # at or above this, the admin is alerted at once
HOLD_HOURS = 72  # how long a high-score alert can wait for a person before its face is deleted
RETENTION_DAYS = 90  # an example: the real figure comes from the shop's DPIA
DEFAULT_THRESHOLD = 80
MIN_ALERT_SCORE = 50  # below this, a camera check leaves nothing behind
MAX_PENDING_CAMERA = 12  # a limit on how much footage can sit waiting for a person
MAX_CLIP_BYTES = 12 * 2**20
CLIP_NAME = re.compile(r"^[0-9]+-[0-9a-f]{12}\.(webm|mp4)$")
# What the browser's rules can report, and the score each gives when no behaviour model is set up. With a model,
# the model's score counts, except that leaving unpaid is always at least a high-score alert for a person.
RULE_SCORES = {"possible_concealment": 72, "left_without_paying": 92, "long_dwell": 30}
RULE_WORDS = {"possible_concealment": "Possible concealment", "left_without_paying": "Left without visiting the till",
              "long_dwell": "Long dwell at the shelf"}

VISIT_STALE_S = 90  # a gap this long means the last visit is over
CAMERA_SYSTEM = """You follow one person through a shop on a camera, a few frames at a time. Faces may be blurred.
Report only what you can see in these frames, using what happened earlier in the visit as context. Say what the person did,
then reason about what it means for the whole visit so far. Holding, looking at or carrying an item is normal, and so is using
a phone or adjusting clothes. Judge only actions, never a person's appearance, clothing, age, race or gender.
Score from 0 to 100 how clearly the whole visit so far shows someone hiding an item or leaving with one they haven't paid for.

Camera layout: {layout}

What the shop's own tracker noticed just now (pose and item detection in code). It can be wrong. Treat it as a lead to
check, never as something you saw: "observed" describes only what is visible in these frames, and if the frames do not
show the item or the action the tracker reports, say so plainly and score it lower.
{events}

Earlier in this visit:
{earlier}"""
CAMERA_SCHEMA = {"type": "object", "additionalProperties": False,
                 "required": ["observed", "picked_up", "put_back", "concealed", "paid", "left_exit", "running", "reasoning", "score"],
                 "properties": {"observed": {"type": "string"}, "picked_up": {"type": "boolean"}, "put_back": {"type": "boolean"},
                                "concealed": {"type": "boolean"}, "paid": {"type": "boolean"}, "left_exit": {"type": "boolean"},
                                "running": {"type": "boolean"}, "reasoning": {"type": "string"}, "score": {"type": "integer"}}}
DEFAULT_LAYOUT = "Walking out of the left edge of the picture means leaving through the exit. The right side is the till."


def follow_visit(visit: dict[str, Any], seen: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Keeps the facts of a visit from what the model reports. Returns the visit and whether they left with something unpaid.

    The model reads the pictures. This rule is plain code, so it can be tested and doesn't drift.
    """
    carrying = visit["carrying"] or bool(seen.get("picked_up")) or bool(seen.get("concealed"))
    if seen.get("put_back") or seen.get("paid"):
        carrying = False
    log = [*visit["log"], str(seen.get("observed", ""))[:200]][-12:]
    return {"log": log, "carrying": carrying}, carrying and bool(seen.get("left_exit"))


# (person, what the behaviour model reported, its score, the truth, which the system doesn't know)
ALERTS = [
    ("P1", "Put two bottles of spirits inside a coat, then walked past the tills.", 94, "theft"),
    ("P2", "Hand moved into a handbag beside the cosmetics shelf. It was a phone going back in the bag.", 93, "innocent"),
    ("P3", "Swapped the barcode label on a drill at self-checkout.", 72, "theft"),
]
# (who it really is, how far today's photo is from their template; bigger means a worse likeness)
VISITORS = [("S1", 0.0), ("P1", 0.40), ("P2", 0.30), ("lookalike of P3", 0.0), ("S2", 0.0), ("P3", 0.30)]


class FaceMatcher(Protocol):
    def template(self, person: str, noise: float = 0.0) -> list[float]: ...

    def score(self, a: list[float], b: list[float]) -> float: ...


class SimulatedFaces:
    """Invented face templates: seeded random vectors, compared by cosine similarity, as face models' embeddings are."""

    SIZE = 64

    def _vector(self, seed: str) -> list[float]:
        rand = random.Random(seed)
        return [rand.gauss(0, 1) for _ in range(self.SIZE)]

    def template(self, person: str, noise: float = 0.0) -> list[float]:
        if person.startswith("lookalike of "):  # a different person who resembles someone
            return self.template(person.removeprefix("lookalike of "), 0.65)
        base = self._vector(person)
        if not noise:
            return base
        other = self._vector(f"{person}:photo:{noise}")
        return [b + noise * o for b, o in zip(base, other)]

    def score(self, a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        return round(100 * dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))), 1)


def descriptor_score(a: list[float], b: list[float]) -> float:
    """Similarity of two browser face descriptors on this lab's 0 to 100 scale. It is not a probability.

    The face model's usual "same person" cut-off is a distance of 0.6. Here 0.6 scores 60, 0.4 scores 80 and 0.3 scores 90,
    so the default threshold of 80 is stricter than the model's own. A real system would calibrate this on its own cameras.
    """
    return round(max(0.0, min(100.0, 120 - 100 * math.dist(a, b))), 1)


SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY, person TEXT, what TEXT, score INTEGER, truth TEXT, status TEXT,
  at TEXT, reviewer TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS watchlist(id INTEGER PRIMARY KEY, alert_id INTEGER, person TEXT, template TEXT, status TEXT,
  reason TEXT, added_by TEXT, at TEXT, expires TEXT);
CREATE TABLE IF NOT EXISTS matches(id INTEGER PRIMARY KEY, entry_id INTEGER, person TEXT, visitor TEXT, score REAL,
  high INTEGER, status TEXT, staff TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS notices(id INTEGER PRIMARY KEY, level TEXT, text TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT, actor TEXT, action TEXT);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS media(alert_id INTEGER PRIMARY KEY, frames TEXT, descriptor TEXT, thumbnail TEXT, at TEXT);
"""
# Columns added after the first version: (table, column, type).
ADDED = [("alerts", "rules", "TEXT"), ("alerts", "reasoning", "TEXT"), ("alerts", "source", "TEXT"),
         ("media", "clip", "TEXT"), ("media", "clip_start", "REAL")]


class StoreWatchService:
    def __init__(self, path: Path, faces: FaceMatcher | None = None, gpt: StructuredModel | None = None,
                 spend: SpendTracker | None = None):
        self.path, self.faces, self.gpt, self.spend = path, faces or SimulatedFaces(), gpt, spend
        self._lock = threading.Lock()
        self.clips = path.parent / "clips"
        self.camera_calls, self.camera_spent_usd = 0, 0.0  # the behaviour model's use since the server started
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript(SCHEMA)
            for table, column, kind in ADDED:
                if column not in {r["name"] for r in db.execute(f"PRAGMA table_info({table})")}:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def _get(self, db: sqlite3.Connection, key: str, default: Any) -> Any:
        row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def _set(self, db: sqlite3.Connection, key: str, value: Any) -> None:
        db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, json.dumps(value)))

    def _now(self, db: sqlite3.Connection) -> datetime:
        return datetime.now(timezone.utc) + timedelta(days=self._get(db, "days_ahead", 0))

    def _audit(self, db: sqlite3.Connection, actor: str, action: str) -> None:
        db.execute("INSERT INTO audit(at,actor,action) VALUES (?,?,?)", (self._now(db).isoformat(), actor, action))

    def _notify(self, db: sqlite3.Connection, level: str, text: str) -> None:
        """An alert for the admin and the system. In a real shop this is where email or Teams would be sent from."""
        db.execute("INSERT INTO notices(level,text,at) VALUES (?,?,?)", (level, text, self._now(db).isoformat()))

    def _drop_media(self, db: sqlite3.Connection, alert_id: int) -> None:
        """Deletes an alert's footage: its frames, face template, thumbnail and the clip file on disk."""
        row = db.execute("SELECT clip FROM media WHERE alert_id=?", (alert_id,)).fetchone()
        if row and row["clip"] and CLIP_NAME.match(row["clip"]):
            (self.clips / row["clip"]).unlink(missing_ok=True)
        db.execute("DELETE FROM media WHERE alert_id=?", (alert_id,))

    def _purge(self, db: sqlite3.Connection) -> None:
        """Deletes every held or live face whose time is up. Runs before anything reads the watchlist."""
        now = self._now(db).isoformat()
        for row in db.execute("SELECT * FROM watchlist WHERE expires<=?", (now,)).fetchall():
            held = row["status"] == "held"
            db.execute("DELETE FROM watchlist WHERE id=?", (row["id"],))
            self._drop_media(db, row["alert_id"])
            if held:
                db.execute("UPDATE alerts SET status='expired' WHERE id=?", (row["alert_id"],))
            self._audit(db, "system", f"Deleted the {'held face from alert' if held else 'watchlist entry for alert'} "
                                      f"{row['alert_id']}: {'nobody reviewed it in time' if held else 'retention period ended'}.")
        cut_off = (self._now(db) - timedelta(hours=HOLD_HOURS)).isoformat()
        for row in db.execute("SELECT a.id FROM alerts a JOIN media m ON m.alert_id=a.id WHERE a.status='pending' AND m.at<=?",
                              (cut_off,)).fetchall():  # camera footage nobody reviewed
            self._drop_media(db, row["id"])
            db.execute("UPDATE alerts SET status='expired' WHERE id=?", (row["id"],))
            self._audit(db, "system", f"Deleted the footage from alert {row['id']}: nobody reviewed it in time.")

    def _demo_mode(self, db: sqlite3.Connection) -> None:
        """Says once in the audit log that the desk runs as a demo, with no governance record required first."""
        if not self._get(db, "demo_noted", False):
            self._set(db, "demo_noted", True)
            self._audit(db, "system", "Demo mode: the desk runs without a recorded lawful basis or DPIA. For a real "
                                      "shop, record them under Governance and take legal advice first.")

    def _open(self, db: sqlite3.Connection, table: str, row_id: int) -> sqlite3.Row:
        row = db.execute(f"SELECT * FROM {table} WHERE id=?", (row_id,)).fetchone()  # table names are constants here
        if row is None:
            raise ApiError(404, "not_found", "That record no longer exists.")
        return row

    def state(self) -> dict[str, Any]:
        with self._lock, self._db() as db:
            self._purge(db)
            self._demo_mode(db)
            rows = lambda sql: [dict(r) for r in db.execute(sql).fetchall()]  # noqa: E731
            alerts = rows("SELECT * FROM alerts ORDER BY score DESC, id")
            media = {r["alert_id"]: r for r in db.execute("SELECT * FROM media").fetchall()}
            for a in alerts:  # the truth is only for teaching, and only once a person has decided
                if a["status"] == "pending":
                    a.pop("truth")
                    if a["id"] in media:
                        m = media[a["id"]]
                        a["frames"] = json.loads(m["frames"])
                        a["has_face"] = bool(m["descriptor"])
                        a["thumbnail"] = m["thumbnail"]
                        a["clip"] = f"/api/storewatch/media/clips/{m['clip']}" if m["clip"] else None
                        a["clip_start"] = m["clip_start"] or 0
            for a in alerts:
                a["rules"] = json.loads(a["rules"]) if a.get("rules") else []
            matches = rows("SELECT m.*, CASE WHEN m.visitor IS NULL THEN NULL WHEN m.person=m.visitor THEN 1 ELSE 0 END AS correct, "
                           "x.thumbnail FROM matches m LEFT JOIN watchlist w ON w.id=m.entry_id "
                           "LEFT JOIN media x ON x.alert_id=w.alert_id ORDER BY m.id DESC")
            for m in matches:
                if m["status"] == "open":
                    m.pop("correct"), m.pop("visitor")
            high_rejected = [a for a in alerts if a["score"] >= HIGH_SCORE and a["status"] == "rejected"]
            return {
                "compliance": self._get(db, "compliance", None),
                "alerts": alerts,
                "watchlist": rows("SELECT w.id,w.alert_id,w.person,w.status,w.reason,w.added_by,w.at,w.expires,x.thumbnail "
                                  "FROM watchlist w LEFT JOIN media x ON x.alert_id=w.alert_id ORDER BY w.id"),
                "camera_visit": self._get(db, "camera_visit", None),
                "camera_calls": self.camera_calls, "camera_spent_usd": round(self.camera_spent_usd, 5),
                "rule_words": RULE_WORDS,
                "default_layout": DEFAULT_LAYOUT,
                "camera_available": self.gpt is not None and bool(self.gpt.models),
                "matches": matches,
                "notices": rows("SELECT * FROM notices ORDER BY id DESC LIMIT 30"),
                "audit": rows("SELECT * FROM audit ORDER BY id DESC LIMIT 40"),
                "visitors_discarded": self._get(db, "discarded", 0),
                "high_score_rejected": len(high_rejected),
                "more_alerts": self._get(db, "next_alert", 0) < len(ALERTS),
                "more_visitors": self._get(db, "next_visitor", 0) < len(VISITORS),
                "days_ahead": self._get(db, "days_ahead", 0),
                "high_score": HIGH_SCORE, "hold_hours": HOLD_HOURS, "retention_days": RETENTION_DAYS,
                "default_threshold": DEFAULT_THRESHOLD,
            }

    def set_compliance(self, controller: str, lawful_basis: str, dpia_reference: str, signage: bool) -> dict[str, Any]:
        if not signage:
            raise ApiError(400, "invalid_request", "Customers must be told before they enter: confirm the signs are up.")
        with self._lock, self._db() as db:
            self._set(db, "compliance", {"controller": controller, "lawful_basis": lawful_basis, "dpia_reference": dpia_reference})
            self._audit(db, controller, f"Recorded lawful basis and DPIA {dpia_reference}.")
        return self.state()

    def next_alert(self) -> dict[str, Any]:
        """The behaviour model's next alert. A high score alerts the admin and holds the face, and adds nobody."""
        with self._lock, self._db() as db:
            i = self._get(db, "next_alert", 0)
            if i >= len(ALERTS):
                raise ApiError(409, "finished", "That was the last alert in this simulation.")
            self._set(db, "next_alert", i + 1)
            person, what, score, truth = ALERTS[i]
            now = self._now(db)
            alert_id = db.execute("INSERT INTO alerts(person,what,score,truth,status,at) VALUES (?,?,?,?,?,?)",
                                  (person, what, score, truth, "pending", now.isoformat())).lastrowid
            self._audit(db, "behaviour model", f"Alert {alert_id}, score {score}.")
            if score >= HIGH_SCORE:
                db.execute("INSERT INTO watchlist(alert_id,person,template,status,reason,at,expires) VALUES (?,?,?,?,?,?,?)",
                           (alert_id, person, json.dumps(self.faces.template(person)), "held", what, now.isoformat(),
                            (now + timedelta(hours=HOLD_HOURS)).isoformat()))
                self._notify(db, "high", f"High-score alert {alert_id} ({score}): review now. {what.split('.')[0]}.")
                self._audit(db, "system", f"Held the face from alert {alert_id} for review and alerted the admin.")
        return self.state()

    def review(self, alert_id: int, reviewer: str, theft: bool, note: str = "", watched_footage: bool = True) -> dict[str, Any]:
        """A named person's decision, with an optional note. This is the only way anyone reaches the live watchlist."""
        with self._lock, self._db() as db:
            self._purge(db)
            alert = self._open(db, "alerts", alert_id)
            if alert["status"] != "pending":
                raise ApiError(409, "already_decided", "That alert has already been dealt with.")
            if theft:
                note = note.strip() or "Confirmed from the footage."
            now = self._now(db)
            expires = (now + timedelta(days=RETENTION_DAYS)).isoformat()
            db.execute("UPDATE alerts SET status=?, reviewer=?, note=? WHERE id=?",
                       ("confirmed" if theft else "rejected", reviewer, note, alert_id))
            media = db.execute("SELECT descriptor FROM media WHERE alert_id=?", (alert_id,)).fetchone()
            if theft and media and not media["descriptor"]:
                raise ApiError(400, "invalid_request", "No face was captured with this alert, so nobody can be added.")
            if not theft:
                db.execute("DELETE FROM watchlist WHERE alert_id=?", (alert_id,))
                self._drop_media(db, alert_id)
                self._audit(db, reviewer, f"Rejected alert {alert_id}. Any held face was deleted.")
            else:
                updated = db.execute("UPDATE watchlist SET status='active', added_by=?, reason=?, expires=? WHERE alert_id=?",
                                     (reviewer, note, expires, alert_id)).rowcount
                if not updated:
                    db.execute("INSERT INTO watchlist(alert_id,person,template,status,reason,added_by,at,expires) VALUES (?,?,?,?,?,?,?,?)",
                               (alert_id, alert["person"], media["descriptor"] if media else json.dumps(self.faces.template(alert["person"])),
                                "active", note, reviewer, now.isoformat(), expires))
                self._audit(db, reviewer, f"Confirmed theft on alert {alert_id}. Added to the watchlist until {expires[:10]}.")
        return self.state()

    def next_visitor(self, threshold: float) -> dict[str, Any]:
        """The next person through the door, compared with live entries only."""
        with self._lock, self._db() as db:
            self._purge(db)
            i = self._get(db, "next_visitor", 0)
            if i >= len(VISITORS):
                raise ApiError(409, "finished", "That was the last visitor in this simulation.")
            self._set(db, "next_visitor", i + 1)
            visitor, noise = VISITORS[i]
            face = self.faces.template(visitor, noise)
            live = [e for e in db.execute("SELECT * FROM watchlist WHERE status='active'").fetchall()
                    if len(json.loads(e["template"])) == len(face)]  # simulated and camera templates can't be compared
            best = max(((self.faces.score(face, json.loads(e["template"])), e) for e in live), key=lambda p: p[0], default=None)
            if best is None or best[0] < threshold:
                self._set(db, "discarded", self._get(db, "discarded", 0) + 1)  # a count, and nothing about the person
                self._audit(db, "door camera", "A visitor matched nobody. Their face template was discarded.")
            else:
                score, entry = best
                high = int(score >= HIGH_SCORE)
                match_id = db.execute("INSERT INTO matches(entry_id,person,visitor,score,high,status,at) VALUES (?,?,?,?,?,?,?)",
                                      (entry["id"], entry["person"], visitor, score, high, "open", self._now(db).isoformat())).lastrowid
                self._audit(db, "door camera", f"Possible match {match_id}, score {score}.")
                self._notify(db, "high" if high else "normal", f"Possible watchlist match at the door, score {score}. "
                                                               "A trained person must check before anyone is approached.")
        return self.state()

    def decide_match(self, match_id: int, staff: str, same_person: bool) -> dict[str, Any]:
        with self._lock, self._db() as db:
            match = self._open(db, "matches", match_id)
            if match["status"] != "open":
                raise ApiError(409, "already_decided", "That match has already been dealt with.")
            db.execute("UPDATE matches SET status=?, staff=? WHERE id=?", ("same" if same_person else "not_same", staff, match_id))
            self._audit(db, staff, f"Match {match_id}: {'same person' if same_person else 'not the same person, no approach made'}.")
        return self.state()

    def remove(self, entry_id: int, by: str, reason: str) -> dict[str, Any]:
        """Takes someone off the list, for an erasure request or a mistake."""
        with self._lock, self._db() as db:
            entry = self._open(db, "watchlist", entry_id)
            db.execute("DELETE FROM watchlist WHERE id=?", (entry_id,))
            self._drop_media(db, entry["alert_id"])
            self._audit(db, by, f"Removed watchlist entry {entry_id}: {reason}")
        return self.state()

    def camera_analyse(self, frames: list[str], descriptor: list[float] | None, thumbnail: str | None,
                       layout: str | None = None, events: list[str] | None = None, rules: list[str] | None = None,
                       track: int | None = None, use_model: bool = True) -> dict[str, Any]:
        """One look at a person on the live desk: the rules the browser's tracker fired, its recent events, and a burst
        of frames. The behaviour model reads the frames with those events and the visit so far as context; with no
        model set up (or use_model off) the rules alone give the score.

        Below MIN_ALERT_SCORE no footage or face is kept. The visit's notes are text about actions, and end with the visit.
        """
        rules = [r for r in (rules or []) if r in RULE_SCORES]
        events = [str(e)[:200] for e in (events or [])][-20:]
        modelled = use_model and self.gpt is not None and bool(self.gpt.models)
        key = str(track or 0)
        with self._lock, self._db() as db:
            waiting = db.execute("SELECT COUNT(*) n FROM alerts a JOIN media m ON m.alert_id=a.id WHERE a.status='pending'").fetchone()["n"]
            visits = {k: v for k, v in self._get(db, "camera_visits", {}).items() if time.time() - v.get("at", 0) <= VISIT_STALE_S}
            visit = visits.get(key) or {"log": [], "carrying": False}
        if waiting >= MAX_PENDING_CAMERA:
            raise ApiError(409, "queue_full", "Review the camera alerts already waiting before checking more footage.")
        cost = 0.0
        if modelled:
            model = self.gpt.models[0]
            parts = [{"type": "text", "text": "Frames in time order:"},
                     *[{"type": "image_url", "image_url": {"url": f, "detail": "low"}} for f in frames]]
            system = CAMERA_SYSTEM.format(layout=layout or DEFAULT_LAYOUT, events="\n".join(events) or "Nothing.",
                                          earlier="\n".join(visit["log"]) or "Nothing yet.")
            message, usage = self.gpt.chat(model, [{"role": "system", "content": system}, {"role": "user", "content": parts}],
                                           schema=CAMERA_SCHEMA, max_tokens=300)
            if self.spend:
                cost = self.spend.charge(SimpleNamespace(usage=usage), model) or 0.0
            self.camera_calls += 1
            self.camera_spent_usd += cost
            answer = json.loads(message.content or "{}")
            score = max(0, min(100, int(answer.get("score", 0))))
        else:  # the rules alone: what the tracker saw, scored by a fixed table
            answer = {"observed": "; ".join(events[-4:]), "reasoning": "Scored by the tracker's rules: no behaviour model looked.",
                      "concealed": "possible_concealment" in rules, "left_exit": "left_without_paying" in rules}
            score = max((RULE_SCORES[r] for r in rules), default=0)
        reasoning = str(answer.get("reasoning", ""))[:400]
        visit, left_unpaid = follow_visit(visit, answer)
        if left_unpaid or (modelled and "left_without_paying" in rules and answer.get("left_exit") and not answer.get("paid")):
            left_unpaid = True
            score = max(score, HIGH_SCORE)  # the rule: an alert for a person, not a finding that this was theft
        observed = str(answer.get("observed", ""))[:300]
        what = f"{observed} {reasoning}".strip()
        alerted = score >= MIN_ALERT_SCORE
        alert_id = None
        with self._lock, self._db() as db:  # leaving ends the visit, and the next person starts a new one
            visits[key] = ({"log": [], "carrying": False, "at": time.time()} if answer.get("left_exit") or "left_without_paying" in rules
                           else {**visit, "at": time.time()})
            self._set(db, "camera_visits", visits)
            self._set(db, "camera_visit", visits[key])
        if alerted:
            with self._lock, self._db() as db:
                n = db.execute("SELECT COUNT(*) n FROM alerts WHERE person LIKE 'Camera person %'").fetchone()["n"] + 1
                person, now = f"Camera person {n}", self._now(db)
                alert_id = db.execute("INSERT INTO alerts(person,what,score,truth,status,at,rules,reasoning,source) VALUES (?,?,?,?,?,?,?,?,?)",
                                      (person, what, score, "unknown", "pending", now.isoformat(), json.dumps(rules), reasoning,
                                       "model" if modelled else "rules")).lastrowid
                template = json.dumps(descriptor) if descriptor else None
                db.execute("INSERT INTO media(alert_id,frames,descriptor,thumbnail,at) VALUES (?,?,?,?,?)",
                           (alert_id, json.dumps(frames), template, thumbnail, now.isoformat()))
                self._audit(db, "behaviour model" if modelled else "tracker rules", f"Camera alert {alert_id}, score {score}.")
                if score >= HIGH_SCORE:
                    if template:
                        db.execute("INSERT INTO watchlist(alert_id,person,template,status,reason,at,expires) VALUES (?,?,?,?,?,?,?)",
                                   (alert_id, person, template, "held", what, now.isoformat(), (now + timedelta(hours=HOLD_HOURS)).isoformat()))
                    self._notify(db, "high", f"High-score camera alert {alert_id} ({score}): review now. {what}")
        return {**self.state(), "last_camera": {"score": score, "what": what, "alerted": alerted, "left_unpaid": left_unpaid,
                                                "carrying": visit["carrying"], "alert_id": alert_id, "modelled": modelled,
                                                "cost_usd": round(cost, 6)}}

    def attach_clip(self, alert_id: int, data: bytes, start_s: float = 0.0) -> dict[str, Any]:
        """Saves the evidence clip the page recorded around an alert, as a file beside the database."""
        kind = "webm" if data[:4] == b"\x1a\x45\xdf\xa3" else "mp4" if data[4:8] == b"ftyp" else None
        if kind is None or len(data) > MAX_CLIP_BYTES:
            raise ApiError(400, "invalid_request", "A clip must be a WebM or MP4 recording under 12 MB.")
        with self._lock, self._db() as db:
            alert = self._open(db, "alerts", alert_id)
            media = db.execute("SELECT clip FROM media WHERE alert_id=?", (alert_id,)).fetchone()
            if alert["status"] != "pending" or media is None:
                raise ApiError(409, "already_decided", "That alert is no longer waiting, so it keeps no footage.")
            if media["clip"] and CLIP_NAME.match(media["clip"]):
                (self.clips / media["clip"]).unlink(missing_ok=True)
            name = f"{alert_id}-{secrets.token_hex(6)}.{kind}"
            self.clips.mkdir(parents=True, exist_ok=True)
            (self.clips / name).write_bytes(data)
            db.execute("UPDATE media SET clip=?, clip_start=? WHERE alert_id=?", (name, max(0.0, start_s), alert_id))
        return self.state()

    def clip_file(self, name: str) -> tuple[Path, str]:
        """The path and media type of a saved clip. The name is checked, so it cannot point outside the folder."""
        path = self.clips / name
        if not CLIP_NAME.match(name) or not path.is_file():
            raise ApiError(404, "not_found", "That clip no longer exists.")
        return path, "video/webm" if name.endswith(".webm") else "video/mp4"

    def camera_door(self, descriptor: list[float], threshold: float) -> dict[str, Any]:
        """Compares one face from the camera with live camera entries. No match means nothing about this face is kept."""
        with self._lock, self._db() as db:
            self._purge(db)
            live = [e for e in db.execute("SELECT * FROM watchlist WHERE status='active'").fetchall()
                    if len(json.loads(e["template"])) == len(descriptor)]
            best = max(((descriptor_score(descriptor, json.loads(e["template"])), e) for e in live), key=lambda p: p[0], default=None)
            if best is None or best[0] < threshold:
                self._set(db, "discarded", self._get(db, "discarded", 0) + 1)
            elif not db.execute("SELECT 1 FROM matches WHERE entry_id=? AND status='open'", (best[1]["id"],)).fetchone():
                score, entry = best
                high = int(score >= HIGH_SCORE)
                match_id = db.execute("INSERT INTO matches(entry_id,person,visitor,score,high,status,at) VALUES (?,?,?,?,?,?,?)",
                                      (entry["id"], entry["person"], None, score, high, "open", self._now(db).isoformat())).lastrowid
                self._audit(db, "door camera", f"Possible match {match_id}, score {score}.")
                self._notify(db, "high" if high else "normal", f"Possible watchlist match at the camera, score {score}. "
                                                               "A trained person must check before anyone is approached.")
        return self.state()

    def advance(self, days: int) -> dict[str, Any]:
        """Moves the simulation's clock on, to see retention work."""
        with self._lock, self._db() as db:
            self._set(db, "days_ahead", self._get(db, "days_ahead", 0) + days)
        return self.state()

    def reset(self) -> dict[str, Any]:
        with self._lock, self._db() as db:
            for row in db.execute("SELECT alert_id FROM media").fetchall():
                self._drop_media(db, row["alert_id"])
            for table in ("alerts", "watchlist", "matches", "notices", "audit", "meta", "media"):
                db.execute(f"DELETE FROM {table}")  # table names are constants here
        return self.state()
