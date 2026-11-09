"""The practice's systems, faked in SQLite: patient records, clinicians' diaries, appointments, texts and an audit log.

MedAssist reaches them through function tools, which run here: the agent replies with a function_call, this code
runs it and sends back a function_call_output. The model decides what to do; these rules, in code, decide
what it is allowed to do, because a prompt is a request and the model does not always follow it:
- The signed-in patient is fixed when the session starts. No tool takes a patient id, so the model cannot be
  talked into reading or booking for someone else.
- The model's arguments are untrusted. Booking accepts only a free slot that find_appointments showed the
  patient in an earlier turn, so the patient has seen the slots and chosen; it claims the slot with one
  conditional UPDATE, so two patients cannot get the same slot.
- Cancelling takes two calls in two turns: the first only asks the patient to confirm.
- Every read of a record and every change is written to the audit log.

Texts are rows in the messages table. Given a notifier (sms.RealTexts), they are also sent as real texts, and a
booking keeps a reminder for 24 hours before; a text that fails is written to the audit log and never undoes the
booking.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

WEEKS_AHEAD = 4
FACE = ["09:00", "09:40", "10:00", "10:40", "11:20", "14:30", "15:30"]
CLINICIANS = [  # id, name, role, {weekday (Monday 0): [(time, kind), ...]}
    ("AZE", "Dr Ana Azevedo", "gp",
     {d: [(t, "face_to_face") for t in FACE] + [("12:00", "phone"), ("12:20", "phone")] for d in (0, 2, 3)}),
    ("OKA", "Dr Tom Okafor", "gp",
     {**{d: [(t, "face_to_face") for t in FACE] + [("12:00", "phone"), ("12:20", "phone")] for d in (0, 1, 4)},
      5: [("09:30", "face_to_face"), ("10:30", "face_to_face")]}),
    ("SHA", "Nurse Priya Shah", "nurse",  # mornings only: blood samples are collected at 13:00
     {**{d: [(t, "face_to_face") for t in ("08:20", "09:10", "10:30", "11:40")] for d in range(5)},
      5: [("10:15", "face_to_face")]}),
    ("LEW", "Ben Lewis (clinical pharmacist)", "pharmacist",
     {d: [("13:30", "face_to_face"), ("15:00", "face_to_face")] for d in (1, 3)}),
]
# The language each patient prefers for calls and texts (python/translator.py's codes). Invented, like the patients.
# English unless a patient prefers another
PREFERRED_LANGUAGE = {"P001": "en", "P002": "en", "P003": "en", "P004": "es", "P005": "pl", "P006": "ar",
                      "P007": "ro", "P008": "ur", "P009": "pa"}
PATIENTS = [  # all invented; 07700 900xxx numbers are reserved by Ofcom for drama
    ("P001", "Valeria Romano", "1986-05-14", "07403289357", "AZE", "Penicillin", "Asthma",
     "Salbutamol inhaler; beclometasone inhaler"),
    ("P002", "Sam Taylor", "1980-03-03", "07700 900456", "OKA", "None known", "High blood pressure", "Lisinopril 10 mg"),
    ("P003", "Margaret Ellis", "1941-11-20", "07700 900789", "AZE", "None known", "Type 2 diabetes", "Metformin"),
    # Patients who prefer other languages, at different ages, to try calls and texts in their language, and the
    # slower, softer voice older patients hear (65 and over, 80 and over).
    ("P004", "Lucía García", "2001-07-09", "07700 900211", "OKA", "None known", "None", "None"),
    ("P005", "Agnieszka Nowak", "1990-02-21", "07700 900212", "AZE", "Latex", "Migraine", "Sumatriptan 50 mg when needed"),
    ("P006", "Fatima Al-Sayed", "1972-10-30", "07700 900213", "OKA", "None known", "Hypothyroidism",
     "Levothyroxine 100 micrograms"),
    ("P007", "Andrei Ionescu", "1958-05-02", "07700 900214", "AZE", "None known", "High cholesterol",
     "Atorvastatin 20 mg"),
    ("P008", "Imran Hussain", "1947-01-15", "07700 900215", "OKA", "Aspirin", "Type 2 diabetes; high blood pressure",
     "Metformin 500 mg; amlodipine 5 mg"),
    ("P009", "Harpreet Kaur", "1939-08-26", "07700 900216", "AZE", "None known", "Osteoarthritis; atrial fibrillation",
     "Paracetamol 1 g when needed; apixaban 2.5 mg"),
]
CALLS = """CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, patient_id TEXT, call_id TEXT, at TEXT,
                                             speaker TEXT, text TEXT);"""
SCHEMA = """
CREATE TABLE clinicians (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE patients (id TEXT PRIMARY KEY, name TEXT NOT NULL, date_of_birth TEXT NOT NULL, phone TEXT NOT NULL,
    registered_gp TEXT REFERENCES clinicians(id), allergies TEXT, conditions TEXT, medications TEXT);
-- One row per slot in a clinician's diary. patient_id NULL means free; 'other' means another patient has it.
CREATE TABLE slots (id TEXT PRIMARY KEY, clinician_id TEXT NOT NULL REFERENCES clinicians(id),
    starts_at TEXT NOT NULL, kind TEXT NOT NULL, patient_id TEXT, reason TEXT, booked_at TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY, patient_id TEXT, sent_to TEXT, body TEXT, sent_at TEXT);
CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT, patient_id TEXT, actor TEXT, action TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, patient_id TEXT, call_id TEXT, at TEXT, speaker TEXT,
                                  text TEXT);
"""
TYPES = {"gp": ("gp", "face_to_face"), "phone": ("gp", "phone"), "nurse": ("nurse", "face_to_face"),
         "pharmacist": ("pharmacist", "face_to_face")}

GET_MY_RECORD = {
    "type": "function", "name": "get_my_record",
    "description": "The signed-in patient's record: name, date of birth, registered GP, allergies, conditions, "
                   "medicines and upcoming appointments. Only ever the signed-in patient's own record.",
    "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
    "strict": True,
}
FIND_APPOINTMENTS = {
    "type": "function", "name": "find_appointments",
    "description": "Free appointments, earliest first, up to six. Offer only slots this returns; never make up a time.",
    "parameters": {
        "type": "object",
        "properties": {
            "appointment_type": {"type": "string", "enum": list(TYPES),
                                 "description": "gp (face to face), phone (GP phone call), nurse (blood tests, "
                                                "vaccinations, dressings, asthma reviews), pharmacist (medicines)"},
            "clinician": {"type": "string", "description": "part of a clinician's name, e.g. Azevedo; empty for anyone"},
            "earliest_date": {"type": "string", "description": "YYYY-MM-DD; today if the patient has no preference"},
            "time_of_day": {"type": "string", "enum": ["any", "morning", "afternoon"]},
        },
        "required": ["appointment_type", "clinician", "earliest_date", "time_of_day"],
        "additionalProperties": False,
    },
    "strict": True,
}
BOOK_APPOINTMENT = {
    "type": "function", "name": "book_appointment",
    "description": "Book a slot that find_appointments offered, for the signed-in patient, once they have chosen it. "
                   "Texts them a confirmation.",
    "parameters": {
        "type": "object",
        "properties": {"slot_id": {"type": "string"},
                       "reason": {"type": "string", "description": "a few words, in the patient's own words"}},
        "required": ["slot_id", "reason"], "additionalProperties": False,
    },
    "strict": True,
}
CANCEL_APPOINTMENT = {
    "type": "function", "name": "cancel_appointment",
    "description": "Cancel one of the signed-in patient's upcoming appointments, after they have confirmed which one. "
                   "Texts them a confirmation.",
    "parameters": {"type": "object", "properties": {"appointment_id": {"type": "string"}},
                   "required": ["appointment_id"], "additionalProperties": False},
    "strict": True,
}
FUNCTION_TOOLS = [GET_MY_RECORD, FIND_APPOINTMENTS, BOOK_APPOINTMENT, CANCEL_APPOINTMENT]


def other_patient_has(slot_id: str) -> bool:
    """About a third of slots are already booked by other patients: the same ones for the same day."""
    return hashlib.sha256(slot_id.encode()).digest()[0] < 85


def create_database(path: Path, today: date | None = None) -> None:
    """A fresh database: clinicians, patients, four weeks of diaries from today, and one existing appointment."""
    today = today or date.today()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
        db.executemany("INSERT INTO clinicians VALUES (?, ?, ?)", [(c[0], c[1], c[2]) for c in CLINICIANS])
        db.executemany("INSERT INTO patients VALUES (?, ?, ?, ?, ?, ?, ?, ?)", PATIENTS)
        for cid, _, _, week in CLINICIANS:
            for n in range(WEEKS_AHEAD * 7 + 1):
                day = today + timedelta(days=n)
                for time, kind in week.get(day.weekday(), []):
                    slot_id = f"{cid}-{day:%Y%m%d}-{time.replace(':', '')}"
                    db.execute("INSERT INTO slots (id, clinician_id, starts_at, kind, patient_id) VALUES (?, ?, ?, ?, ?)",
                               (slot_id, cid, f"{day.isoformat()}T{time}", kind,
                                "other" if other_patient_has(slot_id) else None))
        # Valeria already has an asthma review with the nurse in about ten days.
        db.execute("""UPDATE slots SET patient_id = 'P001', reason = 'Annual asthma review', booked_at = ?
                      WHERE id = (SELECT id FROM slots WHERE clinician_id = 'SHA' AND patient_id IS NULL
                                  AND starts_at >= ? ORDER BY starts_at LIMIT 1)""",
                   (datetime.now().isoformat(timespec="seconds"), (today + timedelta(days=10)).isoformat()))


def when(starts_at: str) -> str:
    return datetime.fromisoformat(starts_at).strftime("%A %-d %B at %H:%M")


@dataclass
class Session:
    """What MedAssist may do for one signed-in patient during one conversation."""
    path: Path
    patient_id: str
    turn: int = 0  # the patient's message number; the caller adds one per message
    offered: dict[str, int] = field(default_factory=dict)  # slot id -> the turn find_appointments showed it
    cancelling: dict[str, int] = field(default_factory=dict)  # appointment id -> the turn confirmation was asked
    notifier: Any = None  # sms.RealTexts for real texts and reminders; None keeps them as database rows only
    language: str = ""  # the patient's preferred language for texts; empty: PREFERRED_LANGUAGE

    def __post_init__(self) -> None:
        self.db = sqlite3.connect(self.path, check_same_thread=False)  # the web backend answers from worker threads
        self.db.row_factory = sqlite3.Row
        self.db.executescript(CALLS)  # a database made before phone calls gets the table now
        add_new_patients(self.db)  # and patients added to the list since
        self.patient = self.db.execute("SELECT * FROM patients WHERE id = ?", (self.patient_id,)).fetchone()
        if self.patient is None:
            raise ValueError(f"No patient {self.patient_id}")
        self.language = self.language or PREFERRED_LANGUAGE.get(self.patient_id, "en")

    def audit(self, action: str, detail: str = "") -> None:
        self.db.execute("INSERT INTO audit (at, patient_id, actor, action, detail) VALUES (?, ?, 'MedAssist', ?, ?)",
                        (datetime.now().isoformat(timespec="seconds"), self.patient_id, action, detail))
        self.db.commit()

    def text(self, body: str) -> str:
        """Sends an SMS: a row in messages, and a real text when there is a notifier. Returns the masked number, which
        is all the model needs."""
        self.db.execute("INSERT INTO messages (patient_id, sent_to, body, sent_at) VALUES (?, ?, ?, ?)",
                        (self.patient_id, self.patient["phone"], body, datetime.now().isoformat(timespec="seconds")))
        self._notify("text sent", lambda n: n.send(self.patient["name"], body, self.language))
        return "mobile ending " + self.patient["phone"][-3:]

    def _notify(self, action: str, do: Callable[[Any], Any]) -> Any:
        """Runs one real-text step if texts are real. A failure is audited, not raised: the booking stands."""
        if self.notifier is None:
            return None
        try:
            result = do(self.notifier)
        except Exception as exc:  # noqa: BLE001  (the network, Azure, a number it refuses)
            self.audit(f"{action}: failed", f"{type(exc).__name__}: {str(exc)[:200]}")
            return None
        if result is not None:
            self.audit(action, str(result))
        return result

    def upcoming(self) -> list[dict]:
        rows = self.db.execute("""SELECT s.id, s.starts_at, s.kind, s.reason, c.name FROM slots s
                                  JOIN clinicians c ON c.id = s.clinician_id
                                  WHERE s.patient_id = ? AND s.starts_at > ? ORDER BY s.starts_at""",
                               (self.patient_id, datetime.now().isoformat(timespec="minutes"))).fetchall()
        return [{"appointment_id": r["id"], "with": r["name"], "when": when(r["starts_at"]),
                 "kind": r["kind"].replace("_", " "), "reason": r["reason"]} for r in rows]

    def get_my_record(self) -> dict:
        p = self.patient
        gp = self.db.execute("SELECT name FROM clinicians WHERE id = ?", (p["registered_gp"],)).fetchone()
        self.audit("record viewed")
        return {"name": p["name"], "date_of_birth": p["date_of_birth"], "registered_gp": gp["name"],
                "allergies": p["allergies"], "conditions": p["conditions"], "medications": p["medications"],
                "mobile": "ending " + p["phone"][-3:], "upcoming_appointments": self.upcoming()}

    def find_appointments(self, appointment_type: str, clinician: str, earliest_date: str, time_of_day: str) -> dict:
        if appointment_type not in TYPES:
            return {"error": f"appointment_type must be one of {', '.join(TYPES)}"}
        role, kind = TYPES[appointment_type]
        now = datetime.now().isoformat(timespec="minutes")
        try:
            start = max(date.fromisoformat(earliest_date[:10]).isoformat(), now)  # ISO strings sort in date order
        except ValueError:
            start = now
        sql = """SELECT s.id, s.starts_at, c.name FROM slots s JOIN clinicians c ON c.id = s.clinician_id
                 WHERE c.role = ? AND s.kind = ? AND s.patient_id IS NULL AND s.starts_at > ? AND s.starts_at >= ?"""
        params: list = [role, kind, now, start]
        if clinician.strip():
            sql += " AND c.name LIKE ?"
            params.append(f"%{clinician.strip()}%")
        if time_of_day in ("morning", "afternoon"):
            sql += " AND substr(s.starts_at, 12, 5) " + ("< '12:00'" if time_of_day == "morning" else ">= '12:00'")
        rows = self.db.execute(sql + " ORDER BY s.starts_at LIMIT 6", params).fetchall()
        for r in rows:
            self.offered.setdefault(r["id"], self.turn)
        if not rows:
            return {"slots": [], "note": "Nothing free in the next four weeks. Suggest another clinician, "
                                         "a phone call, or calling reception on 01632 960 123."}
        return {"slots": [{"slot_id": r["id"], "with": r["name"], "when": when(r["starts_at"])} for r in rows]}

    def book_appointment(self, slot_id: str, reason: str) -> dict:
        if slot_id not in self.offered:
            return {"error": "Book only a slot that find_appointments offered in this conversation."}
        if self.offered[slot_id] == self.turn:
            return {"error": "Not booked: the patient has not seen these slots yet. Show them as a numbered list "
                             "and book the one the patient chooses."}
        slot = self.db.execute("""SELECT s.starts_at, s.kind, c.name FROM slots s JOIN clinicians c
                                  ON c.id = s.clinician_id WHERE s.id = ?""", (slot_id,)).fetchone()
        if slot is None or slot["starts_at"] <= datetime.now().isoformat(timespec="minutes"):
            return {"error": "That slot is no longer available. Find another."}
        if any(a["when"] == when(slot["starts_at"]) for a in self.upcoming()):
            return {"error": "The patient already has an appointment at that time."}
        claimed = self.db.execute(  # claims the slot only if it is still free, in one statement
            "UPDATE slots SET patient_id = ?, reason = ?, booked_at = ? WHERE id = ? AND patient_id IS NULL",
            (self.patient_id, reason[:200], datetime.now().isoformat(timespec="seconds"), slot_id)).rowcount
        if not claimed:
            self.db.commit()
            return {"error": "Someone else has just booked that slot. Find another."}
        sent_to = self.text(f"Harbourside Medical Centre: your appointment with {slot['name']} is on "
                            f"{when(slot['starts_at'])}. Ref {slot_id}. To cancel, use the app or call 01632 960 123.")
        self.audit("appointment booked", f"{slot_id} with {slot['name']}: {reason[:200]}")
        reminder = self._notify("reminder kept", lambda n: n.schedule(
            slot_id, self.patient["name"], f"Harbourside Medical Centre: a reminder that your appointment with "
            f"{slot['name']} is tomorrow, {when(slot['starts_at'])}. Ref {slot_id}. To cancel, use the app or call "
            "01632 960 123.", slot["starts_at"], self.language))
        booked = {"booked": True, "appointment_id": slot_id, "with": slot["name"], "when": when(slot["starts_at"]),
                  "kind": slot["kind"].replace("_", " "), "confirmation_sent_to": sent_to}
        if reminder:
            booked["reminder"] = "a text the day before"
        if slot_id.startswith("SHA-"):
            booked["next_step"] = ("Search the practice documents for how to prepare for this nurse appointment and "
                                   "tell the patient, keeping any conditions the documents give.")
        return booked

    def cancel_appointment(self, appointment_id: str) -> dict:
        mine = {a["appointment_id"]: a for a in self.upcoming()}
        if appointment_id not in mine:  # someone else's, in the past, or made up
            return {"error": "That is not one of the patient's upcoming appointments."}
        if self.cancelling.get(appointment_id, self.turn) == self.turn:
            self.cancelling[appointment_id] = self.turn
            a = mine[appointment_id]
            return {"cancelled": False, "confirm_first": f"Ask the patient to confirm cancelling {a['with']} on "
                                                         f"{a['when']}. Call cancel_appointment again after they say yes."}
        self.db.execute("UPDATE slots SET patient_id = NULL, reason = NULL, booked_at = NULL WHERE id = ?",
                        (appointment_id,))
        self._notify("reminder dropped", lambda n: n.cancel(appointment_id))
        a = mine[appointment_id]
        sent_to = self.text(f"Harbourside Medical Centre: your appointment with {a['with']} on {a['when']} "
                            "has been cancelled.")
        self.audit("appointment cancelled", f"{appointment_id} with {a['with']}")
        return {"cancelled": True, "appointment_id": appointment_id, "with": a["with"], "when": a["when"],
                "confirmation_sent_to": sent_to}

    def call(self, name: str, args: dict) -> dict:
        tools = {"get_my_record": self.get_my_record, "find_appointments": self.find_appointments,
                 "book_appointment": self.book_appointment, "cancel_appointment": self.cancel_appointment}
        if name not in tools:
            return {"error": f"There is no tool called {name}."}
        try:
            return tools[name](**args)
        except TypeError as exc:  # wrong or missing arguments
            return {"error": f"Bad arguments for {name}: {exc}"}


def add_new_patients(db: sqlite3.Connection) -> None:
    """Patients added to PATIENTS since the database was made, so it gains them without a reset."""
    db.executemany("INSERT OR IGNORE INTO patients VALUES (?, ?, ?, ?, ?, ?, ?, ?)", PATIENTS)
    db.commit()


def age_of(date_of_birth: str, today: date | None = None) -> int:
    born, today = date.fromisoformat(date_of_birth), today or date.today()
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


def phone_note(today: date | None = None, language: str = "English") -> str:
    """What the phone line tells the agent at the start of a call: spoken, so no lists or markdown, and in the
    caller's language."""
    today = today or date.today()
    return (f"Today is {today:%A %d %B %Y} ({today.isoformat()}). This is a phone call to the practice: your words are "
            "spoken aloud. Keep each reply to two or three short sentences with no lists, markdown or symbols. Offer "
            "at most three slots, by day and time, and ask which one the caller wants. The phone line has already "
            "confirmed the caller's date of birth. "
            f"The caller speaks {language}: reply in {language}, in simple words, whatever language the tools use.")


def log_call(path: Path, patient_id: str, call_id: str, speaker: str, text: str) -> None:
    """One line of a phone call, in the practice record: the caller, the assistant, or the line itself."""
    with sqlite3.connect(path) as db:
        db.executescript(CALLS)
        db.execute("INSERT INTO calls (patient_id, call_id, at, speaker, text) VALUES (?, ?, ?, ?, ?)",
                   (patient_id, call_id, datetime.now().isoformat(timespec="seconds"), speaker, text))


def log_event(path: Path, patient_id: str, action: str, detail: str = "") -> None:
    """A phone call's own event (answered, ended, emergency, identity not confirmed) in the audit log."""
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO audit (at, patient_id, actor, action, detail) VALUES (?, ?, 'Phone line', ?, ?)",
                   (datetime.now().isoformat(timespec="seconds"), patient_id, action, detail))


def portal_note(session: Session, today: date | None = None) -> str:
    """What the portal tells the agent at the start of a conversation: the date, and who is signed in."""
    today = today or date.today()
    return (f"Today is {today:%A %d %B %Y} ({today.isoformat()}). "
            f"The signed-in patient is {session.patient['name']}; the portal has verified who they are.")


def reply_text(response) -> str:
    """The reply's text. The model sometimes sends the same message item twice; show it once."""
    parts: list[str] = []
    for item in response.output:
        if item.type == "message":
            text = "".join(c.text for c in item.content if c.type == "output_text").strip()
            if text and text not in parts:
                parts.append(text)
    return "\n\n".join(parts)


def run_turn(respond: Callable[[object], object], session: Session, text: str, max_rounds: int = 6,
             on_step: Callable[[dict], None] = lambda step: None) -> tuple[str, list[dict]]:
    """One patient message, through to MedAssist's reply. respond(input) sends input to the agent in this
    conversation and returns its response; the command line and the lab backend each pass their own.

    Foundry runs File Search and the Code Interpreter itself and reports them in the output. Function calls
    come back here: each runs against the session, and the results go back as function_call_output items,
    round after round, until the agent answers in words. Returns the reply and every step on the way.
    """
    session.turn += 1  # what the tools may do depends on which turn things happened in
    steps: list[dict] = []
    response = respond(text)
    for _ in range(max_rounds):
        outputs = []
        for item in response.output:
            step = None
            if item.type == "file_search_call":
                step = {"tool": "file_search", "queries": list(item.queries or [])}
            elif item.type == "code_interpreter_call":
                step = {"tool": "code_interpreter", "code": item.code or ""}
            elif item.type == "function_call":
                try:
                    args = json.loads(item.arguments)
                    result = session.call(item.name, args)
                except json.JSONDecodeError:
                    args, result = item.arguments, {"error": "The arguments were not valid JSON."}
                step = {"tool": item.name, "args": args, "result": result}
                outputs.append({"type": "function_call_output", "call_id": item.call_id, "output": json.dumps(result)})
            if step:
                steps.append(step)
                on_step(step)
        if not outputs:
            return reply_text(response), steps
        response = respond(outputs)
    return "(MedAssist stopped: too many tool calls in one turn.)", steps


def snapshot(path: Path, patient_id: str, limit: int = 20) -> dict:
    """What the practice's systems hold for one patient: the view a member of staff would have. Reading it is
    not MedAssist reading the record, so it is not audited as one."""
    with sqlite3.connect(path) as db:
        db.row_factory = sqlite3.Row
        add_new_patients(db)
        p = db.execute("""SELECT p.*, c.name AS gp FROM patients p JOIN clinicians c ON c.id = p.registered_gp
                          WHERE p.id = ?""", (patient_id,)).fetchone()
        if p is None:
            raise ValueError(f"No patient {patient_id}")
        upcoming = db.execute("""SELECT s.id, s.starts_at, s.kind, s.reason, c.name FROM slots s
                                 JOIN clinicians c ON c.id = s.clinician_id
                                 WHERE s.patient_id = ? AND s.starts_at > ? ORDER BY s.starts_at""",
                              (patient_id, datetime.now().isoformat(timespec="minutes"))).fetchall()
        texts = db.execute("SELECT sent_at, sent_to, body FROM messages WHERE patient_id = ? ORDER BY id DESC LIMIT ?",
                           (patient_id, limit)).fetchall()
        audit = db.execute("SELECT at, actor, action, detail FROM audit WHERE patient_id = ? ORDER BY id DESC LIMIT ?",
                           (patient_id, limit)).fetchall()
        db.executescript(CALLS)
        calls = db.execute("SELECT at, call_id, speaker, text FROM calls WHERE patient_id = ? ORDER BY id DESC LIMIT ?",
                           (patient_id, limit * 3)).fetchall()
    return {
        "patient": {"id": p["id"], "name": p["name"], "date_of_birth": p["date_of_birth"], "phone": p["phone"],
                    "registered_gp": p["gp"], "allergies": p["allergies"], "conditions": p["conditions"],
                    "medications": p["medications"]},
        "upcoming": [{"appointment_id": r["id"], "with": r["name"], "when": when(r["starts_at"]),
                      "kind": r["kind"].replace("_", " "), "reason": r["reason"]} for r in upcoming],
        "texts": [dict(r) for r in texts],
        "audit": [dict(r) for r in audit],
        "calls": [dict(r) for r in reversed(calls)],  # phone calls, oldest line first
    }
