"""MedAssist's real texts and reminders (examples/medassist/sms.py), with fakes in place of Azure: no texts, no cost."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace as NS

import pytest

from backend.app.shared import medassist_clinic as clinic, medassist_sms as sms

PATIENT = clinic.PATIENTS[0][0]


class Notifier:
    """Records what the clinic asked for, or fails on request."""

    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    def send(self, patient, body, language="en"):
        if self.fail:
            raise RuntimeError("network down")
        self.calls.append(("send", patient, body))
        return "msg-1"

    def schedule(self, appointment_id, patient, body, starts_at, language="en"):
        self.calls.append(("schedule", appointment_id, starts_at))
        return "2026-11-12T12:00:00+00:00"

    def cancel(self, appointment_id):
        self.calls.append(("cancel", appointment_id))


def session(tmp_path, notifier):
    path = tmp_path / "practice.db"
    clinic.create_database(path, today=date.today())
    return clinic.Session(path, PATIENT, notifier=notifier)


def book_first_gp_slot(s):
    s.turn = 1
    slot = s.find_appointments("gp", "", "", "any")["slots"][0]["slot_id"]
    s.turn = 2  # the patient has seen the slots and chosen one
    return s.book_appointment(slot, "blood pressure review")


def test_a_booking_sends_a_real_text_and_keeps_a_reminder_and_cancelling_drops_it(tmp_path):
    n = Notifier()
    s = session(tmp_path, n)
    booked = book_first_gp_slot(s)
    assert booked["booked"] and booked["reminder"] == "a text the day before"
    kinds = [c[0] for c in n.calls]
    assert kinds == ["send", "schedule"] and n.calls[1][1] == booked["appointment_id"]
    assert "Harbourside Medical Centre" in n.calls[0][2]
    s.turn = 3
    s.cancel_appointment(booked["appointment_id"])  # asks for confirmation first
    s.turn = 4
    assert s.cancel_appointment(booked["appointment_id"])["cancelled"]
    assert ("cancel", booked["appointment_id"]) in n.calls


def test_a_text_that_fails_is_audited_and_the_booking_stands(tmp_path):
    s = session(tmp_path, Notifier(fail=True))
    booked = book_first_gp_slot(s)
    assert booked["booked"]
    audit = [r["action"] for r in s.db.execute("SELECT action FROM audit")]
    assert "text sent: failed" in audit and "appointment booked" in audit


def test_without_a_notifier_texts_stay_rows_in_the_database(tmp_path):
    s = session(tmp_path, None)
    booked = book_first_gp_slot(s)
    assert booked["booked"] and "reminder" not in booked
    assert s.db.execute("SELECT COUNT(*) FROM messages").fetchone()[0] >= 1


def test_numbers_are_sent_in_international_form():
    assert sms.e164("07700 900456") == "+447700900456"
    assert sms.e164("+44 7403 289357") == "+447403289357"
    assert sms.e164("0044 7403 289357") == "+447403289357"


def test_a_reminder_is_due_24_hours_before_in_utc_and_never_in_the_past():
    start = (datetime.now() + timedelta(days=3)).replace(second=0, microsecond=0)
    due = sms.reminder_due(start.isoformat(timespec="minutes"))
    local = start.replace(tzinfo=sms.UK)
    assert due == (local - timedelta(hours=24)).astimezone(timezone.utc)
    assert sms.reminder_due((datetime.now() + timedelta(hours=2)).isoformat(timespec="minutes")) is None


def test_real_texts_go_to_your_phone_labelled_and_reminders_are_table_rows():
    sent, rows, deleted = [], [], []
    fake_sms = NS(send=lambda **k: sent.append(k) or [NS(successful=True, message_id="m1", error_message=None,
                                                            http_status_code=202)])
    fake_table = NS(upsert_entity=rows.append, delete_entity=lambda **k: deleted.append(k))
    t = sms.RealTexts("https://acs", "Durjan Lab", "07403 289357", "https://table", sms=fake_sms, table=fake_table)
    assert t.send("Sam Taylor", "Your appointment...") == "m1"
    assert sent[0]["to"] == "+447403289357" and sent[0]["from_"] == "Durjan Lab"
    assert sent[0]["message"].startswith("[Lab text for Sam Taylor] ")
    start = (datetime.now() + timedelta(days=5)).isoformat(timespec="minutes")
    t.schedule("OKA-1", "Sam Taylor", "Reminder...", start)
    assert rows[0]["RowKey"] == "OKA-1" and rows[0]["remind_at"].endswith("Z")
    t.cancel("OKA-1")
    assert deleted == [{"partition_key": "medassist", "row_key": "OKA-1"}]
    assert sms.from_settings("https://acs", "Durjan Lab", "", "https://table") is None  # no phone: no real texts


def test_a_text_azure_refuses_raises_so_the_clinic_can_audit_it():
    refused = NS(send=lambda **k: [NS(successful=False, message_id=None, error_message="unregistered sender",
                                      http_status_code=400)])
    t = sms.RealTexts("https://acs", "Durjan Lab", "07403289357", "https://table", sms=refused, table=NS())
    with pytest.raises(RuntimeError, match="unregistered sender"):
        t.send("Sam Taylor", "hi")


class Polish:
    """Stands in for Translator: marks the text as translated."""

    def translate(self, text, to, source=None):
        return f"<{to}> {text}"


def test_a_text_goes_in_the_patients_language_and_english_when_translation_fails():
    sent = []
    fake_sms = NS(send=lambda **k: sent.append(k) or [NS(successful=True, message_id="m1", error_message=None,
                                                            http_status_code=202)])
    t = sms.RealTexts("https://acs", "Durjan Lab", "07403289357", "https://table", sms=fake_sms, table=NS(),
                      translator=Polish())
    t.send("Sam Taylor", "Your appointment is on Monday.", "pl")
    assert sent[-1]["message"] == "[Lab text for Sam Taylor] <pl> Your appointment is on Monday."
    t.send("Sam Taylor", "Your appointment is on Monday.", "en")
    assert sent[-1]["message"].endswith("] Your appointment is on Monday.")  # English: not translated

    class Down:
        def translate(self, *a):
            raise OSError("no network")

    t.translator = Down()
    t.send("Sam Taylor", "Your appointment is on Monday.", "pl")
    assert sent[-1]["message"].endswith("] Your appointment is on Monday.")  # the English, rather than nothing


def test_the_clinic_texts_in_the_patients_preferred_language(tmp_path):
    n = Notifier()
    path = tmp_path / "practice.db"
    clinic.create_database(path, today=date.today())
    s = clinic.Session(path, PATIENT, notifier=n, language="pl")
    calls = []
    n.send = lambda patient, body, language="en": calls.append(language) or "m1"
    book_first_gp_slot(s)
    assert calls == ["pl"]
    assert clinic.Session(path, "P001").language == clinic.PREFERRED_LANGUAGE["P001"]  # from the record otherwise
