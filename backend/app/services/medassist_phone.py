"""The practice's phone line: when reception is busy, MedAssist answers, and can book an appointment with a doctor.

Someone rings the lab's number. Event Grid tells this server (through a dev tunnel) that a call is coming in, and the
line answers it. Before the MedAssist agent hears anything, code decides three things the agent cannot be talked
out of:
- Who may call. The patients are invented, so only your own phone is answered, as one of them (MEDASSIST_PHONE_PATIENT,
  Sam Taylor by default). Anyone else is told to ring reception.
- Emergencies. Every sentence the caller says goes through Aftercare's emergency screen first (chest pain, cannot
  breathe, stroke signs...). On a match the line tells them to hang up and call 999, records it, and ends the call.
- Identity. The caller must say a date of birth that matches the record. A model turns the spoken date into
  YYYY-MM-DD; the comparison is code. Three misses and the line says reception will call back.
Then MedAssist takes over with the same tools and rules as the portal: it finds slots, reads them out, books the one
the caller chooses and texts the confirmation. Every line of the call and its events go into the practice record.
"""
from __future__ import annotations

import hmac
import logging
import secrets
import threading
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Callable

from ..core.errors import ApiError
from ..gateways.phone import PhoneLine, pace_for_age
from ..shared import aftercare_ward as ward, medassist_clinic as clinic, translator as T
from .medassist import MedAssistService

log = logging.getLogger("llm_lab")
GOODBYE = "goodbye"
MAX_MISSES = 2  # silences asked about again before the line gives up
MAX_DOB_TRIES = 3
SAY = {
    "hello": ("Harbourside Medical Centre. Everyone is busy at the moment, so you are through to the practice's "
              "automated assistant. If this is an emergency, hang up and call 999 now. To help you, please tell me "
              "your date of birth."),
    "stranger": ("Harbourside Medical Centre. This automated line only answers the lab's test phone. Please call "
                 "reception on 01632 960 123. Goodbye."),
    "emergency": ("This could be an emergency. Please hang up now and call 999. I have told the practice. Goodbye."),
    "who": "Thank you, {name}. How can I help you today?",
    "dob_again": "Sorry, that doesn't match our records. Please tell me your date of birth again.",
    "dob_fail": ("I'm sorry, I can't confirm who you are. Reception will call you back on this number. Goodbye."),
    "again": "Sorry, I didn't catch that. ",
    "deaf": "I'm sorry, I can't hear you. Reception will call you back. Goodbye.",
    "fault": "Sorry, something has gone wrong on our side. Reception will call you back. Goodbye.",
}


@dataclass
class InboundCall:
    id: str
    token: str  # in this call's events address
    caller: str
    known: bool  # the lab's test phone, so it is answered as the test patient
    connection_id: str = ""
    state: str = "ringing"  # ringing, talking, ended
    verified: bool = False
    dob_tries: int = 0
    misses: int = 0
    chat_id: str = ""  # the MedAssist conversation, once the caller is confirmed
    last: str = ""  # what the line said last, to say again after a silence
    last_english: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)


class MedAssistPhone:
    def __init__(self, medassist: MedAssistService, line: PhoneLine | None, your_phone: str, patient_id: str,
                 callback_base: str, token: str, read_date: Callable[[str], str | None], missing: list[str] | None = None,
                 archive: Any = None, translator: Any = None, language: str = ""):
        self.medassist, self.line, self.your_phone, self.patient_id = medassist, line, your_phone, patient_id
        self.base, self.token, self.read_date = callback_base.rstrip("/"), token, read_date
        self.missing = missing or []
        self.archive = archive  # services/transcripts.py
        self.translator = translator  # python/translator.py: the caller's language, and English for the record
        self.language = language or clinic.PREFERRED_LANGUAGE.get(patient_id, "en")
        self.calls: dict[str, InboundCall] = {}
        born = next((p[2] for p in clinic.PATIENTS if p[0] == patient_id), "")
        self.pace = pace_for_age(ward.age_on(born, date.today())) if born else "normal"

    def info(self) -> dict[str, Any]:
        return {"configured": self.line is not None and not self.missing, "missing": self.missing,
                "patient": self.patient_id, "language": T.name_of(self.language)}

    # ----- the record -----
    def _db(self):
        return self.medassist._database()

    def _log(self, call: InboundCall, speaker: str, text: str, english: str = "") -> None:
        """One line of the call, as said, with the English beside it when it was said in another language."""
        shown = f"{text}\n[English] {english}" if english and english != text else text
        clinic.log_call(self._db(), self.patient_id, call.id, speaker, shown)
        if self.archive is not None:
            self.archive.line("medassist", call.id, self.patient_id, "phone", speaker, text, self.language, english)

    def _event(self, action: str, detail: str = "", call: InboundCall | None = None) -> None:
        clinic.log_event(self._db(), self.patient_id, action, detail)
        if self.archive is not None and call is not None:
            self.archive.event("medassist", call.id, self.patient_id, "phone", action, detail)

    def _say(self, call: InboundCall, text: str, english: str = "", *, listen: bool = True) -> None:
        """Speaks to the caller in their language and writes it to the record; listens unless the call is ending."""
        call.last, call.last_english = text, english
        self._log(call, "assistant", text, english)
        if listen:
            self.line.say_and_listen(call.connection_id, call.caller, text, self.language, "turn", self.pace)
        else:
            self.line.say(call.connection_id, text, self.language, GOODBYE, self.pace)

    def _phrase(self, call: InboundCall, key: str, *, listen: bool = True, **fill: str) -> None:
        """The line's own reviewed English wording, translated for the caller; the English goes in the record."""
        english = SAY[key].format(**fill)
        self._say(call, T.to_language(self.translator, english, self.language), english, listen=listen)

    # ----- Event Grid: a call is coming in -----
    def incoming(self, token: str, events: list[dict]) -> dict[str, Any]:
        if not self.token or not hmac.compare_digest(token, self.token):
            raise ApiError(404, "not_found", "No such line.")
        for e in events:
            kind, data = e.get("eventType", ""), e.get("data") or {}
            if kind == "Microsoft.EventGrid.SubscriptionValidationEvent":  # Event Grid checking this address is ours
                return {"validationResponse": data.get("validationCode", "")}
            if kind == "Microsoft.Communication.IncomingCall" and self.line is not None:
                caller = ((data.get("from") or {}).get("phoneNumber") or {}).get("value", "")
                call = InboundCall(secrets.token_hex(12), secrets.token_urlsafe(24), caller,
                                   known=bool(self.your_phone) and caller == self.your_phone)
                self.calls[call.id] = call
                url = f"{self.base}/api/medassist/phone/events/{call.id}?token={call.token}"
                call.connection_id = self.line.answer(data["incomingCallContext"], url)
        return {}

    # ----- Call Automation: what happens on the call -----
    def events(self, call_id: str, token: str, events: list[dict]) -> None:
        call = self.calls.get(call_id)
        if call is None or not hmac.compare_digest(token, call.token):
            raise ApiError(404, "not_found", "No such call.")
        for e in events:
            kind, data = str(e.get("type", "")).rsplit(".", 1)[-1], e.get("data") or {}
            if kind == "CallConnected":
                call.state = "talking"
                if not call.known:
                    self.line.say(call.connection_id, SAY["stranger"], "en", GOODBYE)
                    continue
                self._event("phone call answered", f"the practice line, from the lab's test phone, in "
                                                   f"{T.name_of(self.language)}", call=call)
                self._phrase(call, "hello")
            elif kind == "RecognizeCompleted":
                heard = ((data.get("speechResult") or {}).get("speech") or "").strip()
                target = self._heard if heard else self._missed
                threading.Thread(target=target, args=(call, heard), daemon=True).start()
            elif kind == "RecognizeFailed":
                threading.Thread(target=self._missed, args=(call, ""), daemon=True).start()
            elif kind == "PlayCompleted" and data.get("operationContext") == GOODBYE:
                self.line.hang_up(call.connection_id)
            elif kind == "CallDisconnected":
                call.state = "ended"
                if call.known:
                    self._event("phone call ended", call=call)
                if call.chat_id:
                    self.medassist.end(call.chat_id)

    def _heard(self, call: InboundCall, heard: str) -> None:
        with call.lock:
            call.misses = 0
            english = T.to_english(self.translator, heard, self.language)
            self._log(call, "caller", heard, english)
            # Before the agent, before anything else; in the caller's words and in English, so a caller speaking
            # Polish or Urdu about chest pain is caught too.
            if word := (ward.screen(heard) or ward.screen(english)):
                self._event("emergency words on a phone call", f"'{word}': told to call 999", call=call)
                self._phrase(call, "emergency", listen=False)
                return
            if not call.verified:
                self._check_identity(call, english or heard)
                return
            try:
                turn = self.medassist.message(call.chat_id, heard, archive=False)  # this call keeps its own lines
            except ApiError as exc:
                log.warning("MedAssist phone turn failed: %s", exc.message)
                self._event("phone call fault", exc.message, call=call)
                self._phrase(call, "fault", listen=False)
                return
            self._say(call, turn["reply"], T.to_english(self.translator, turn["reply"], self.language))

    def _check_identity(self, call: InboundCall, heard: str) -> None:
        """The date of birth: a model reads the spoken date; code compares it with the record."""
        patient = next(p for p in clinic.PATIENTS if p[0] == self.patient_id)
        if self.read_date(heard) == patient[2]:
            call.verified = True
            self._event("caller's identity confirmed", "date of birth matched the record", call=call)
            note = clinic.phone_note(language=T.name_of(self.language))
            call.chat_id = self.medassist.start(self.patient_id, note=note)["chat_id"]
            self._phrase(call, "who", name=patient[1].split()[0])
            return
        call.dob_tries += 1
        if call.dob_tries >= MAX_DOB_TRIES:
            self._event("caller's identity not confirmed", f"{MAX_DOB_TRIES} dates of birth did not match", call=call)
            self._phrase(call, "dob_fail", listen=False)
        else:
            self._phrase(call, "dob_again")

    def _missed(self, call: InboundCall, _: str = "") -> None:
        with call.lock:
            call.misses += 1
            if call.misses > MAX_MISSES:
                self._event("phone call: caller not heard", call=call)
                self._phrase(call, "deaf", listen=False)
            else:
                again = T.to_language(self.translator, SAY["again"], self.language)
                last, last_english = call.last.removeprefix(again), call.last_english.removeprefix(SAY["again"])
                self._say(call, again + last, SAY["again"] + last_english if last_english else "")
