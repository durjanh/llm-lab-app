"""Real confirmations for the hotel booking agent, through Azure Communication Services, signed in with your Azure login.

The guests are invented, so every real text and email goes to one phone and one inbox you choose (HOTEL_SMS_TO,
HOTEL_EMAIL_TO), labelled with the guest it is for. The hotel's outbox still records each one against the guest's own
number and address. A channel without its settings stays off, and its messages stay in the outbox.
"""
from __future__ import annotations

from typing import Any

from ..shared import medassist_sms


class AcsNotifier:
    """Texts through the Communication Services SMS client; emails through its Email client."""

    def __init__(self, endpoint: str, sms_sender: str, sms_to: str, email_sender: str, email_to: str,
                 sms_client: Any = None, email_client: Any = None):
        self.endpoint, self.sms_sender, self.email_sender = endpoint, sms_sender, email_sender
        self.sms_to = medassist_sms.e164(sms_to) if sms_to else ""
        self.email_to = email_to
        self._sms, self._email = sms_client, email_client
        self.sms = bool(endpoint and sms_to and sms_sender)
        self.email = bool(endpoint and email_to and email_sender)

    def _credential(self) -> Any:
        from azure.identity import DefaultAzureCredential
        return DefaultAzureCredential()

    def send_sms(self, guest: str, to: str, body: str) -> str:
        if self._sms is None:
            from azure.communication.sms import SmsClient
            self._sms = SmsClient(self.endpoint, self._credential())
        result = self._sms.send(from_=self.sms_sender, to=self.sms_to, message=f"[Lab text for {guest}, {to}] {body}")[0]
        if not result.successful:
            raise RuntimeError(f"Text not sent: {result.error_message or result.http_status_code}")
        return f"to {self.sms_to}, id {result.message_id}"

    def send_email(self, guest: str, to: str, subject: str, body: str) -> str:
        if self._email is None:
            from azure.communication.email import EmailClient  # pip install azure-communication-email
            self._email = EmailClient(self.endpoint, self._credential())
        message = {"senderAddress": self.email_sender, "recipients": {"to": [{"address": self.email_to}]},
                   "content": {"subject": f"[Lab email for {guest}, {to}] {subject}", "plainText": body}}
        result = self._email.begin_send(message).result()
        if (result.get("status") or "").lower() != "succeeded":
            raise RuntimeError(f"Email not sent: {result.get('error') or result.get('status')}")
        return f"to {self.email_to}, id {result.get('id')}"


def from_settings(endpoint: str, sms_sender: str, sms_to: str, email_sender: str, email_to: str) -> AcsNotifier | None:
    """A notifier when at least one channel is configured; None keeps every confirmation in the outbox."""
    notifier = AcsNotifier(endpoint, sms_sender, sms_to, email_sender, email_to)
    return notifier if (notifier.sms or notifier.email) else None
