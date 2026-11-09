"""Aftercare's follow-up call to a real phone: the agent rings your number and holds the same conversation as the page.

The page asks for a call; this starts an Aftercare call (the same agent, tools and rules as AftercareService) and
has Communication Services ring AFTERCARE_CALL_TO. From then on Communication Services reports each step to the
events route, and each step becomes an Aftercare turn: what the person said goes through the same screening (the
emergency words, the 999 line) as a typed message, and the agent's reply is spoken back. When the checklist is done
the agent says goodbye and hangs up; if it cannot hear the person, it says the care team will call and hangs up.

Only your own number is ever rung: the patients are invented. Each call's events need a token made for that call,
so nobody can drive a call by guessing its address, and requests that came in through the tunnel reach only the
events route (main.py).
"""
from __future__ import annotations

import hmac
import logging
import secrets
import threading
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from ..core.errors import ApiError
from ..gateways.phone import PhoneLine, pace_for_age
from ..shared import aftercare_ward as ward, translator as T
from .aftercare import AftercareService

log = logging.getLogger("llm_lab")
GOODBYE = "goodbye"  # the operation context of the last thing said; when it finishes, the call ends
MAX_MISSES = 2  # times the agent asks again when it hears nothing
SAID = {  # what the line says itself, outside the agent's turns
    "en": {"again": "Sorry, I didn't catch that. ",
           "deaf": "I'm sorry, I can't hear you, so I'll ask the care team to call you instead. Goodbye.",
           "fault": "Sorry, something has gone wrong on our side. The care team will call you instead. Goodbye."},
    "es": {"again": "Perdone, no le he entendido. ",
           "deaf": "Lo siento, no le oigo, así que pediré al equipo que le llame. Adiós.",
           "fault": "Lo siento, ha habido un problema. El equipo le llamará. Adiós."},
}


@dataclass
class PhoneCall:
    call_id: str  # the Aftercare call this phone call carries
    patient_id: str
    token: str  # in the events address; made for this call only
    language: str
    reply: str  # what the agent said last, to say again if it was not heard
    connection_id: str = ""
    pace: str = "normal"  # slower for older patients: see gateways/phone.py
    state: str = "ringing"  # ringing, talking, ended, failed
    misses: int = 0
    note: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)


class AftercarePhone:
    def __init__(self, aftercare: AftercareService, line: PhoneLine | None, to: str, callback_base: str,
                 missing: list[str] | None = None, archive: Any = None, translator: Any = None):
        self.translator = translator  # python/translator.py: English copies of what is said in Spanish
        self.archive = archive  # services/transcripts.py: this call's lines, the line's own words included
        self.aftercare, self.line, self.to, self.base = aftercare, line, to, callback_base.rstrip("/")
        self.missing = missing or []  # the settings still to set, for the page's explanation
        self.calls: dict[str, PhoneCall] = {}

    def info(self) -> dict[str, Any]:
        return {"configured": self.line is not None and not self.missing, "missing": self.missing,
                "to": f"ending {self.to[-3:]}" if self.to else ""}

    def start(self, patient_id: str, engine: str, model: str | None) -> dict[str, Any]:
        if self.line is None or self.missing:
            raise ApiError(503, "not_configured", "Real calls need " + ", ".join(self.missing or ["the phone settings"])
                           + " in .env, and the backend restarted. See examples/aftercare/README.md.")
        started = self.aftercare.start(patient_id, engine, model, archive=False)  # the opening, before it rings
        call = PhoneCall(started["call_id"], patient_id, secrets.token_urlsafe(24),
                         ward.BY_ID[patient_id].get("language", "en"), started["reply"])
        call.pace = pace_for_age(ward.age_on(ward.BY_ID[patient_id]["dob"], date.today()))
        url = f"{self.base}/api/aftercare/phone/events/{call.call_id}?token={call.token}"
        try:
            call.connection_id = self.line.call(self.to, url)
        except Exception as exc:  # noqa: BLE001  (no number, a number it refuses, the network)
            self.aftercare.end(call.call_id)
            raise ApiError(502, "call_failed", f"The call could not be placed: {str(exc)[:300]}") from exc
        self.calls[call.call_id] = call
        self._keep(call, "agent", call.reply)
        self._note(call, "phone call placed", f"to the lab's test phone ending {self.to[-3:]}")
        return {**started, "phone": self._state(call)}

    def _words(self, call: PhoneCall) -> dict[str, str]:
        """What the line says itself, in the patient's language: written for English and Spanish, translated from
        the English for any other."""
        if call.language in SAID:
            return SAID[call.language]
        return {k: T.to_language(self.translator, v, call.language) for k, v in SAID["en"].items()}

    def _keep(self, call: PhoneCall, speaker: str, text: str, english: str = "") -> None:
        if self.archive is not None:
            self.archive.line("aftercare", call.call_id, call.patient_id, "phone", speaker, text, call.language,
                              english)

    def _english(self, call: PhoneCall, speaker: str, text: str) -> str:
        """An English copy for the staff, in the record beside the line, when it was said in another language."""
        english = T.to_english(self.translator, text, call.language)
        self.aftercare.english_copy(call.call_id, speaker, english)
        return english

    def _note(self, call: PhoneCall, action: str, detail: str = "", said: str = "") -> None:
        """A call event in the patient's record and the archive; what the line said, in both transcripts."""
        self.aftercare.phone_note(call.call_id, action, detail, said=said)
        if self.archive is not None:
            self.archive.event("aftercare", call.call_id, call.patient_id, "phone", action, detail)
        self._keep(call, "line", said)

    def _state(self, call: PhoneCall) -> dict[str, Any]:
        return {"state": call.state, "note": call.note, "to": f"ending {self.to[-3:]}"}

    def status(self, call_id: str) -> dict[str, Any]:
        call = self.calls.get(call_id)
        if call is None:
            raise ApiError(404, "not_found", "There is no phone call with that id.")
        return {"phone": self._state(call), "record": self.aftercare.record(call.patient_id)}

    def events(self, call_id: str, token: str, events: list[dict]) -> None:
        """Communication Services' report of what happened on the call. Answers at once; turns run in the background."""
        call = self.calls.get(call_id)
        if call is None or not hmac.compare_digest(token, call.token):
            raise ApiError(404, "not_found", "No such call.")
        for e in events:
            kind, data = str(e.get("type", "")).rsplit(".", 1)[-1], e.get("data") or {}
            if kind == "CallConnected":
                call.state = "talking"
                self._note(call, "phone call answered")
                self.line.say_and_listen(call.connection_id, self.to, call.reply, call.language, "turn", call.pace)
            elif kind == "RecognizeCompleted":
                heard = ((data.get("speechResult") or {}).get("speech") or "").strip()
                if heard:
                    threading.Thread(target=self._answer, args=(call, heard), daemon=True).start()
                else:
                    threading.Thread(target=self._missed, args=(call,), daemon=True).start()
            elif kind == "RecognizeFailed":
                threading.Thread(target=self._missed, args=(call,), daemon=True).start()
            elif kind == "PlayCompleted" and data.get("operationContext") == GOODBYE:
                self.line.hang_up(call.connection_id)
            elif kind in ("CallDisconnected", "CreateCallFailed", "AnswerFailed"):
                call.state = "failed" if kind != "CallDisconnected" else "ended"
                reason = (data.get("resultInformation") or {}).get("message", "")
                call.note = call.note or reason
                self._note(call, "phone call ended" if kind == "CallDisconnected" else "phone call failed",
                                          reason)
                self.aftercare.end(call.call_id)

    def _answer(self, call: PhoneCall, heard: str) -> None:
        """What the person said, through the same Aftercare turn as a typed message; the reply is spoken back."""
        with call.lock:
            try:
                turn = self.aftercare.message(call.call_id, heard)
                self._keep(call, "patient", heard, self._english(call, "patient", heard))
            except ApiError as exc:
                log.warning("Aftercare phone turn failed: %s", exc.message)
                call.note = exc.message
                self.aftercare.call_back(call.call_id, "Phone follow-up stopped by a fault: please call the patient.")
                self._note(call, "phone call fault", exc.message, said=self._words(call)["fault"])
                self.line.say(call.connection_id, self._words(call)["fault"], call.language, GOODBYE, call.pace)
                return
            call.reply, call.misses = turn["reply"], 0
            self._keep(call, "agent", turn["reply"], self._english(call, "agent", turn["reply"]))
            if turn["done"]:
                self.line.say(call.connection_id, turn["reply"], call.language, GOODBYE, call.pace)
            else:
                self.line.say_and_listen(call.connection_id, self.to, turn["reply"], call.language, "turn", call.pace)

    def _missed(self, call: PhoneCall) -> None:
        with call.lock:
            call.misses += 1
            words = self._words(call)
            if call.misses > MAX_MISSES:
                call.note = "Could not hear the person; the care team was asked to call."
                self.aftercare.call_back(call.call_id, "Phone follow-up: the patient could not be heard. Please call them.")
                self._note(call, "phone call: patient not heard", said=words["deaf"])
                self.line.say(call.connection_id, words["deaf"], call.language, GOODBYE, call.pace)
            else:
                self._note(call, "phone call: nothing heard, asked again", said=words["again"].strip())
                self.line.say_and_listen(call.connection_id, self.to, words["again"] + call.reply, call.language, "turn", call.pace)
