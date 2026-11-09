"""A shoplifting alert desk: behaviour alerts, a person's decision, a watchlist, and a check at the door.

This is a simulation with invented people. No camera or real face is involved, and SimulatedFaces is the only matcher.
The rules are the real part, and they are enforced here rather than on the page:

- A high behaviour score alerts the admin and holds the person for review. It never puts anyone on the live watchlist.
- Only a named person who says they watched the footage can confirm a theft, and only then can the door match them.
- A held face that nobody confirms is deleted. So is every live entry when its retention period ends.
- A visitor who matches nobody is compared and forgotten: nothing about them is stored.
- A door match is a possible match. Staff decide, and a wrong match is recorded.
- Nothing can be confirmed or matched until the shop has recorded its legal basis, DPIA and signage.
"""
from __future__ import annotations

import json
import math
import random
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

from ..core.errors import ApiError

HIGH_SCORE = 90  # at or above this, the admin is alerted at once
HOLD_HOURS = 72  # how long a high-score alert can wait for a person before its face is deleted
RETENTION_DAYS = 90  # an example: the real figure comes from the shop's DPIA
DEFAULT_THRESHOLD = 80

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
"""


class StoreWatchService:
    def __init__(self, path: Path, faces: FaceMatcher | None = None):
        self.path, self.faces = path, faces or SimulatedFaces()
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript(SCHEMA)

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

    def _purge(self, db: sqlite3.Connection) -> None:
        """Deletes every held or live face whose time is up. Runs before anything reads the watchlist."""
        now = self._now(db).isoformat()
        for row in db.execute("SELECT * FROM watchlist WHERE expires<=?", (now,)).fetchall():
            held = row["status"] == "held"
            db.execute("DELETE FROM watchlist WHERE id=?", (row["id"],))
            if held:
                db.execute("UPDATE alerts SET status='expired' WHERE id=?", (row["alert_id"],))
            self._audit(db, "system", f"Deleted the {'held face from alert' if held else 'watchlist entry for alert'} "
                                      f"{row['alert_id']}: {'nobody reviewed it in time' if held else 'retention period ended'}.")

    def _require_ready(self, db: sqlite3.Connection) -> None:
        if not self._get(db, "compliance", None):
            raise ApiError(409, "not_ready", "Record the lawful basis, DPIA and signage first. Until then nobody can be "
                                             "confirmed or matched.")

    def _open(self, db: sqlite3.Connection, table: str, row_id: int) -> sqlite3.Row:
        row = db.execute(f"SELECT * FROM {table} WHERE id=?", (row_id,)).fetchone()  # table names are constants here
        if row is None:
            raise ApiError(404, "not_found", "That record no longer exists.")
        return row

    def state(self) -> dict[str, Any]:
        with self._lock, self._db() as db:
            self._purge(db)
            rows = lambda sql: [dict(r) for r in db.execute(sql).fetchall()]  # noqa: E731
            alerts = rows("SELECT * FROM alerts ORDER BY score DESC, id")
            for a in alerts:  # the truth is only for teaching, and only once a person has decided
                if a["status"] == "pending":
                    a.pop("truth")
            matches = rows("SELECT m.*, CASE WHEN m.person=m.visitor THEN 1 ELSE 0 END AS correct FROM matches m ORDER BY id DESC")
            for m in matches:
                if m["status"] == "open":
                    m.pop("correct"), m.pop("visitor")
            high_rejected = [a for a in alerts if a["score"] >= HIGH_SCORE and a["status"] == "rejected"]
            return {
                "compliance": self._get(db, "compliance", None),
                "alerts": alerts,
                "watchlist": rows("SELECT id,alert_id,person,status,reason,added_by,at,expires FROM watchlist ORDER BY id"),
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

    def review(self, alert_id: int, reviewer: str, theft: bool, note: str, watched_footage: bool) -> dict[str, Any]:
        """A person's decision. This is the only way anyone reaches the live watchlist."""
        with self._lock, self._db() as db:
            self._purge(db)
            alert = self._open(db, "alerts", alert_id)
            if alert["status"] != "pending":
                raise ApiError(409, "already_decided", "That alert has already been dealt with.")
            if theft:
                self._require_ready(db)
                if not watched_footage:
                    raise ApiError(400, "invalid_request", "Watch the footage before confirming a theft.")
                if len(note.strip()) < 15:
                    raise ApiError(400, "invalid_request", "Say what you saw, in a sentence: this is the evidence.")
            now = self._now(db)
            expires = (now + timedelta(days=RETENTION_DAYS)).isoformat()
            db.execute("UPDATE alerts SET status=?, reviewer=?, note=? WHERE id=?",
                       ("confirmed" if theft else "rejected", reviewer, note, alert_id))
            if not theft:
                db.execute("DELETE FROM watchlist WHERE alert_id=?", (alert_id,))
                self._audit(db, reviewer, f"Rejected alert {alert_id}. Any held face was deleted.")
            else:
                updated = db.execute("UPDATE watchlist SET status='active', added_by=?, reason=?, expires=? WHERE alert_id=?",
                                     (reviewer, note, expires, alert_id)).rowcount
                if not updated:
                    db.execute("INSERT INTO watchlist(alert_id,person,template,status,reason,added_by,at,expires) VALUES (?,?,?,?,?,?,?,?)",
                               (alert_id, alert["person"], json.dumps(self.faces.template(alert["person"])), "active", note, reviewer,
                                now.isoformat(), expires))
                self._audit(db, reviewer, f"Confirmed theft on alert {alert_id}. Added to the watchlist until {expires[:10]}.")
        return self.state()

    def next_visitor(self, threshold: float) -> dict[str, Any]:
        """The next person through the door, compared with live entries only."""
        with self._lock, self._db() as db:
            self._purge(db)
            self._require_ready(db)
            i = self._get(db, "next_visitor", 0)
            if i >= len(VISITORS):
                raise ApiError(409, "finished", "That was the last visitor in this simulation.")
            self._set(db, "next_visitor", i + 1)
            visitor, noise = VISITORS[i]
            face = self.faces.template(visitor, noise)
            live = db.execute("SELECT * FROM watchlist WHERE status='active'").fetchall()
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
            self._open(db, "watchlist", entry_id)
            db.execute("DELETE FROM watchlist WHERE id=?", (entry_id,))
            self._audit(db, by, f"Removed watchlist entry {entry_id}: {reason}")
        return self.state()

    def advance(self, days: int) -> dict[str, Any]:
        """Moves the simulation's clock on, to see retention work."""
        with self._lock, self._db() as db:
            self._set(db, "days_ahead", self._get(db, "days_ahead", 0) + days)
        return self.state()

    def reset(self) -> dict[str, Any]:
        with self._lock, self._db() as db:
            for table in ("alerts", "watchlist", "matches", "notices", "audit", "meta"):
                db.execute(f"DELETE FROM {table}")  # table names are constants here
        return self.state()
