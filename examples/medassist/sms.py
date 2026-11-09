"""MedAssist's real texts: a confirmation through Azure Communication Services when an appointment is booked or
cancelled, and a reminder 24 hours before it.

The reminder is a row in an Azure Storage table. A small Azure Function (reminders/) looks every 15 minutes for rows
that are due, sends them and deletes them; cancelling an appointment deletes its row first. A row needs no server to
be running at the time, and nothing here costs anything while it is idle.

A text goes in the patient's preferred language: Azure Translator translates the reviewed English wording (python/
translator.py), and the practice database keeps the English. If Translator cannot be reached, the English is sent.

The patients are invented, and their numbers are Ofcom's drama numbers, so every real text goes to one phone you
choose (MEDASSIST_SMS_TO), labelled with the patient it is for. The practice database still records the text against
the patient's own number, as before. Signed in with your Azure login (or the Function's managed identity): no keys.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

UK = ZoneInfo("Europe/London")  # appointment times are the practice's local time
PARTITION = "medassist"
REMINDER_LEAD = timedelta(hours=24)


def e164(number: str) -> str:
    """A UK number as Communication Services wants it: 07700 900456 -> +447700900456."""
    digits = re.sub(r"[^\d+]", "", number)
    if digits.startswith("+"):
        return digits
    if digits.startswith("00"):
        return "+" + digits[2:]
    if digits.startswith("0"):
        return "+44" + digits[1:]
    return "+" + digits


def reminder_due(starts_at: str) -> datetime | None:
    """When the reminder should go, in UTC: 24 hours before a local start time. None if that time has passed."""
    start = datetime.fromisoformat(starts_at).replace(tzinfo=UK)
    due = (start - REMINDER_LEAD).astimezone(timezone.utc)
    return due if due > datetime.now(timezone.utc) else None


class RealTexts:
    """Sends texts and keeps reminders. Made with the settings, or with fakes in tests."""

    def __init__(self, endpoint: str, sender: str, to: str, table_url: str, sms: Any = None, table: Any = None,
                 translator: Any = None):
        self.sender, self.to = sender, e164(to)
        self.translator = translator  # translator.Translator, for texts in the patient's language
        self._sms, self._table = sms, table
        self.endpoint, self.table_url = endpoint, table_url

    def _credential(self) -> Any:
        from azure.identity import DefaultAzureCredential
        return DefaultAzureCredential()

    @property
    def sms(self) -> Any:
        if self._sms is None:
            from azure.communication.sms import SmsClient
            self._sms = SmsClient(self.endpoint, self._credential())
        return self._sms

    @property
    def table(self) -> Any:
        if self._table is None:
            from azure.data.tables import TableClient
            self._table = TableClient(self.table_url, table_name="reminders", credential=self._credential())
        return self._table

    def _in(self, body: str, language: str) -> str:
        """The reviewed English wording in the patient's language; the English if that is theirs or Translator fails."""
        if language == "en" or self.translator is None:
            return body
        try:
            return self.translator.translate(body, language, "en")
        except Exception:  # noqa: BLE001  (the network, Azure): the English is better than no text
            return body

    def send(self, patient: str, body: str, language: str = "en") -> str:
        """Sends one text now, in the patient's language, and returns its message id. Raises if Communication
        Services did not accept it."""
        result = self.sms.send(from_=self.sender, to=self.to,
                               message=f"[Lab text for {patient}] {self._in(body, language)}")[0]
        if not result.successful:
            raise RuntimeError(f"Text not sent: {result.error_message or result.http_status_code}")
        return result.message_id

    def schedule(self, appointment_id: str, patient: str, body: str, starts_at: str, language: str = "en") -> str | None:
        """Keeps a reminder to send 24 hours before the appointment. Returns when, or None when that has passed."""
        due = reminder_due(starts_at)
        if due is None:
            return None
        self.table.upsert_entity({"PartitionKey": PARTITION, "RowKey": appointment_id, "to": self.to,
                                  "from": self.sender, "body": f"[Lab text for {patient}] {self._in(body, language)}",
                                  "remind_at": due.strftime("%Y-%m-%dT%H:%M:%SZ")})
        return due.isoformat()

    def cancel(self, appointment_id: str) -> None:
        """Forgets a reminder, so a cancelled appointment is never reminded. No reminder is not an error."""
        self.table.delete_entity(partition_key=PARTITION, row_key=appointment_id)


def from_settings(endpoint: str, sender: str, to: str, table_url: str, translator: Any = None) -> RealTexts | None:
    """Real texts when all three are configured; None keeps texts as rows in the practice database."""
    if not (endpoint and to and table_url):
        return None
    return RealTexts(endpoint, sender, to, table_url, translator=translator)
