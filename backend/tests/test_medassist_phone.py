"""The practice's phone line (services/medassist_phone.py): a fake phone line and a fake MedAssist agent, with the
real practice database, so what the call leaves in the patient's record is checked for real. No call, no cost."""
from __future__ import annotations

from datetime import date
from urllib.parse import parse_qs, urlsplit

import pytest

from backend.app.core.errors import ApiError
from backend.app.services import medassist_phone as P
from backend.app.shared import medassist_clinic as clinic

YOU = "+447403289357"
SAM = "P002"  # Sam Taylor, born 1980-03-03


class Line:
    def __init__(self):
        self.did, self.callback = [], ""

    def answer(self, context, callback_url):
        self.callback = callback_url
        self.did.append(("answer", context))
        return "conn-1"

    def say_and_listen(self, connection_id, to, text, language, context, pace="normal"):
        self.did.append(("ask", text))

    def say(self, connection_id, text, language, context, pace="normal"):
        self.did.append(("say", text, context))

    def hang_up(self, connection_id):
        self.did.append(("hang up",))


class MedAssist:
    """The agent, scripted; the database is the real practice database."""

    def __init__(self, path, replies=()):
        self.path, self.replies, self.started, self.heard = path, list(replies), [], []
        clinic.create_database(path, today=date.today())

    def _database(self):
        return self.path

    def start(self, patient_id, note=None):
        self.started.append((patient_id, note))
        return {"chat_id": "chat-1"}

    def message(self, chat_id, text, archive=True):
        self.heard.append(text)
        return {"reply": self.replies.pop(0)}

    def end(self, chat_id):
        pass


class Now:
    def __init__(self, target, args, daemon=True):
        self.target, self.args = target, args

    def start(self):
        self.target(*self.args)


@pytest.fixture(autouse=True)
def synchronous(monkeypatch):
    monkeypatch.setattr(P.threading, "Thread", Now)


def dates(heard):
    """Stands in for the model that reads a spoken date."""
    return {"third of March 1980": "1980-03-03", "first of May 1990": "1990-05-01"}.get(heard)


def line_for(tmp_path, replies=()):
    agent, line = MedAssist(tmp_path / "practice.db", replies), Line()
    phone = P.MedAssistPhone(agent, line, YOU, SAM, "https://tunnel.example", "line-secret", dates)
    return phone, agent, line


def ring(phone, line, caller=YOU):
    phone.incoming("line-secret", [{"eventType": "Microsoft.Communication.IncomingCall",
                                    "data": {"from": {"phoneNumber": {"value": caller}}, "incomingCallContext": "ctx"}}])
    q = urlsplit(line.callback)
    call_id = q.path.rsplit("/", 1)[-1]
    send = lambda *evs: phone.events(call_id, parse_qs(q.query)["token"][0], list(evs))  # noqa: E731
    send({"type": "Microsoft.Communication.CallConnected", "data": {}})
    return send


def said(text):
    return {"type": "Microsoft.Communication.RecognizeCompleted", "data": {"speechResult": {"speech": text}}}


def test_event_grid_checks_the_address_and_needs_the_lines_token(tmp_path):
    phone, _, _ = line_for(tmp_path)
    ok = phone.incoming("line-secret", [{"eventType": "Microsoft.EventGrid.SubscriptionValidationEvent",
                                         "data": {"validationCode": "abc"}}])
    assert ok == {"validationResponse": "abc"}
    with pytest.raises(ApiError):
        phone.incoming("guess", [])


def test_you_ring_the_practice_confirm_who_you_are_and_book_with_the_doctor(tmp_path):
    phone, agent, line = line_for(tmp_path, ["I have Monday at 12:00 or Tuesday at 12:00 with Dr Okafor. Which suits you?",
                                             "Booked: Monday at 12:00 with Dr Tom Okafor. I've texted you the details."])
    send = ring(phone, line)
    assert line.did[0] == ("answer", "ctx") and "call 999" in line.did[1][1]  # the emergency line comes first
    send(said("first of May 1990"))
    assert line.did[-1][1] == P.SAY["dob_again"] and not agent.started  # wrong date: the agent hears nothing
    send(said("third of March 1980"))
    assert agent.started == [(SAM, clinic.phone_note())] and line.did[-1][1] == "Thank you, Sam. How can I help you today?"
    send(said("A phone appointment with Dr Okafor please."))
    send(said("Monday please."))
    assert agent.heard == ["A phone appointment with Dr Okafor please.", "Monday please."]
    assert "Booked" in line.did[-1][1]
    send({"type": "Microsoft.Communication.CallDisconnected", "data": {}})
    record = clinic.snapshot(tmp_path / "practice.db", SAM)
    lines = [(c["speaker"], c["text"]) for c in record["calls"]]
    assert lines[0][0] == "assistant" and ("caller", "Monday please.") in lines and "Booked" in lines[-1][1]
    actions = {a["action"] for a in record["audit"]}
    assert {"phone call answered", "caller's identity confirmed", "phone call ended"} <= actions


def test_emergency_words_end_the_call_with_999_before_the_agent_hears_anything(tmp_path):
    phone, agent, line = line_for(tmp_path)
    send = ring(phone, line)
    send(said("My husband has chest pain and can't breathe"))
    assert line.did[-1] == ("say", P.SAY["emergency"], P.GOODBYE) and not agent.started and not agent.heard
    record = clinic.snapshot(tmp_path / "practice.db", SAM)
    assert any(a["action"] == "emergency words on a phone call" for a in record["audit"])
    assert ("caller", "My husband has chest pain and can't breathe") in [(c["speaker"], c["text"]) for c in record["calls"]]


def test_three_wrong_dates_of_birth_and_reception_calls_back(tmp_path):
    phone, agent, line = line_for(tmp_path)
    send = ring(phone, line)
    for _ in range(3):
        send(said("first of May 1990"))
    assert line.did[-1] == ("say", P.SAY["dob_fail"], P.GOODBYE) and not agent.started


def test_another_number_is_sent_to_reception_and_nothing_is_recorded(tmp_path):
    phone, agent, line = line_for(tmp_path)
    ring(phone, line, caller="+447700900999")
    assert line.did[-1] == ("say", P.SAY["stranger"], P.GOODBYE)
    assert clinic.snapshot(tmp_path / "practice.db", SAM)["calls"] == []


def test_every_line_of_the_call_and_its_events_are_kept_for_future_reference(tmp_path):
    from backend.app.services.transcripts import TranscriptArchive

    agent, line = MedAssist(tmp_path / "practice.db", ["Booked: Monday at 12:00 with Dr Tom Okafor."]), Line()
    archive = TranscriptArchive(tmp_path / "kept")
    phone = P.MedAssistPhone(agent, line, YOU, SAM, "https://tunnel.example", "line-secret", dates, archive=archive)
    send = ring(phone, line)
    send(said("first of May 1990"))
    send(said("third of March 1980"))
    send(said("Monday at noon with Dr Okafor please."))
    send({"type": "Microsoft.Communication.CallDisconnected", "data": {}})
    call_id = next(iter(phone.calls))
    kept = archive.conversation("medassist", call_id)
    spoken = [(k["speaker"], k["text"]) for k in kept if "speaker" in k]
    assert spoken[0] == ("assistant", P.SAY["hello"])  # the line's own words are kept, not only the agent's
    assert ("caller", "first of May 1990") in spoken and ("assistant", P.SAY["dob_again"]) in spoken
    assert spoken[-1] == ("assistant", "Booked: Monday at 12:00 with Dr Tom Okafor.")
    assert [k["event"] for k in kept if "event" in k] == ["phone call answered", "caller's identity confirmed",
                                                         "phone call ended"]
    assert all(k["patient"] == SAM and k["channel"] == "phone" for k in kept)


def test_a_reset_keeps_a_copy_of_the_database_first(tmp_path):
    from backend.app.services.transcripts import TranscriptArchive

    db = tmp_path / "practice.db"
    clinic.create_database(db, today=date.today())
    clinic.log_call(db, SAM, "c1", "caller", "Hello")
    copy = TranscriptArchive(tmp_path / "kept").keep_database(db)
    clinic.create_database(db, today=date.today())  # the reset
    assert clinic.snapshot(db, SAM)["calls"] == [] and clinic.snapshot(copy, SAM)["calls"][0]["text"] == "Hello"


class ToPolish:
    """Stands in for Translator: English to Polish by a small phrasebook, and Polish back to English."""
    POLISH = {"Mam ból w klatce piersiowej.": "I have chest pain.", "trzeci marca 1980": "third of March 1980",
              "Poproszę wizytę u lekarza.": "I would like an appointment with the doctor.",
              "Mam poniedziałek o 12:00.": "I have Monday at 12:00."}

    def translate(self, text, to, source=None):
        if to == "en":
            return self.POLISH.get(text, f"(en) {text}")
        return f"<pl> {text}"


def polish_line(tmp_path, replies=()):
    agent, line = MedAssist(tmp_path / "practice.db", replies), Line()
    phone = P.MedAssistPhone(agent, line, YOU, SAM, "https://tunnel.example", "line-secret", dates,
                             translator=ToPolish(), language="pl")
    return phone, agent, line


def test_a_polish_caller_about_chest_pain_is_caught_through_the_english(tmp_path):
    phone, agent, line = polish_line(tmp_path)
    send = ring(phone, line)
    assert line.did[1] == ("ask", "<pl> " + P.SAY["hello"])  # the reviewed English, translated for the caller
    send(said("Mam ból w klatce piersiowej."))
    assert line.did[-1] == ("say", "<pl> " + P.SAY["emergency"], P.GOODBYE) and not agent.started
    calls = clinic.snapshot(tmp_path / "practice.db", SAM)["calls"]
    assert ("caller", "Mam ból w klatce piersiowej.\n[English] I have chest pain.") in [(c["speaker"], c["text"]) for c in calls]


def test_a_polish_caller_books_in_polish_and_the_record_keeps_the_english(tmp_path):
    phone, agent, line = polish_line(tmp_path, ["Mam poniedziałek o 12:00."])
    send = ring(phone, line)
    send(said("trzeci marca 1980"))  # the date is read from the English translation
    assert agent.started and "reply in Polish" in agent.started[0][1]
    send(said("Poproszę wizytę u lekarza."))
    assert line.did[-1] == ("ask", "Mam poniedziałek o 12:00.")  # the agent already replies in Polish
    calls = [(c["speaker"], c["text"]) for c in clinic.snapshot(tmp_path / "practice.db", SAM)["calls"]]
    assert ("assistant", "Mam poniedziałek o 12:00.\n[English] I have Monday at 12:00.") in calls
    assert phone.info()["language"] == "Polish"
