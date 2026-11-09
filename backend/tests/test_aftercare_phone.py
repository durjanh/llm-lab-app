"""Aftercare's real phone call (services/aftercare_phone.py), with a fake phone line and a fake Aftercare agent: no call,
no Azure, no cost. Communication Services' events are fed in by hand, in the order a real call sends them."""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest

from backend.app.core.errors import ApiError
from backend.app.services import aftercare_phone as P

PATIENT = "P101"


class Line:
    """Records what would have been said and done on the call."""

    def __init__(self, fail=False):
        self.did, self.callback, self.fail = [], "", fail

    def call(self, to, callback_url):
        if self.fail:
            raise RuntimeError("no such number")
        self.callback = callback_url
        self.did.append(("call", to))
        return "conn-1"

    def say_and_listen(self, connection_id, to, text, language, context, pace="normal"):
        self.did.append(("ask", text))

    def say(self, connection_id, text, language, context, pace="normal"):
        self.did.append(("say", text, context))

    def hang_up(self, connection_id):
        self.did.append(("hang up",))


class Aftercare:
    """The agent, scripted: each message gets the next reply; the last one finishes the call."""

    def __init__(self, replies):
        self.replies, self.heard, self.ended, self.tasks, self.notes = list(replies), [], [], [], []

    def start(self, patient_id, engine, model, archive=True):
        return {"call_id": "c1", "reply": "Hello, this is Harbourside General Hospital. What is your date of birth?"}

    def message(self, call_id, text):
        self.heard.append(text)
        reply = self.replies.pop(0)
        return {"reply": reply, "done": not self.replies}

    def end(self, call_id):
        self.ended.append(call_id)

    def call_back(self, call_id, reason):
        self.tasks.append(reason)

    def english_copy(self, call_id, speaker, english):
        pass

    def phone_note(self, call_id, action, detail="", said=""):
        self.notes.append((action, said))

    def record(self, patient_id):
        return {"patient": patient_id}


class Now:
    """Runs a background turn at once, so the test sees its effect straight away."""

    def __init__(self, target, args, daemon=True):
        self.target, self.args = target, args

    def start(self):
        self.target(*self.args)


@pytest.fixture(autouse=True)
def synchronous(monkeypatch):
    monkeypatch.setattr(P.threading, "Thread", Now)


def phone(replies=("Thank you. Are you taking your new tablets?", "Thanks, that's everything. Goodbye."), line=None):
    agent, line = Aftercare(replies), line or Line()
    return P.AftercarePhone(agent, line, "+447403289357", "https://tunnel.example"), agent, line


def ev(kind, **data):
    return {"type": f"Microsoft.Communication.{kind}", "data": data}


def token_of(line):
    return parse_qs(urlsplit(line.callback).query)["token"][0]


def test_the_agent_rings_your_number_and_holds_the_conversation_until_it_says_goodbye():
    p, agent, line = phone()
    started = p.start(PATIENT, "claude", None)
    assert started["phone"]["state"] == "ringing" and line.did[0] == ("call", "+447403289357")
    assert line.callback.startswith("https://tunnel.example/api/aftercare/phone/events/c1?token=")
    t = token_of(line)
    p.events("c1", t, [ev("CallConnected")])
    assert line.did[-1] == ("ask", agent.start(PATIENT, "", None)["reply"])  # the opening is spoken first
    p.events("c1", t, [ev("RecognizeCompleted", speechResult={"speech": "Twelfth of March 1946."})])
    assert agent.heard == ["Twelfth of March 1946."] and line.did[-1][0] == "ask"
    p.events("c1", t, [ev("RecognizeCompleted", speechResult={"speech": "Yes, every morning."})])
    assert line.did[-1] == ("say", "Thanks, that's everything. Goodbye.", P.GOODBYE)  # done: no more listening
    p.events("c1", t, [ev("PlayCompleted", operationContext=P.GOODBYE)])
    assert line.did[-1] == ("hang up",)
    p.events("c1", t, [ev("CallDisconnected")])
    assert p.status("c1")["phone"]["state"] == "ended" and agent.ended == ["c1"]
    actions = [n[0] for n in agent.notes]  # the call's own events are in the patient's record
    assert actions == ["phone call placed", "phone call answered", "phone call ended"]


def test_silence_is_asked_again_twice_then_the_care_team_is_asked_to_call():
    p, agent, line = phone()
    p.start(PATIENT, "claude", None)
    t = token_of(line)
    for _ in range(3):
        p.events("c1", t, [ev("RecognizeFailed")])
    asks = [d for d in line.did if d[0] == "ask"]
    assert len(asks) == 2 and all(a[1].startswith("Sorry, I didn't catch that.") for a in asks)
    assert line.did[-1][0] == "say" and line.did[-1][2] == P.GOODBYE and "care team" in line.did[-1][1]
    assert agent.tasks and "could not be heard" in agent.tasks[0]
    said = [n[1] for n in agent.notes if n[1]]  # what the line itself said is in the transcript too
    assert said[:2] == ["Sorry, I didn't catch that."] * 2 and "care team" in said[2]


def test_events_need_the_calls_own_token():
    p, _, line = phone()
    p.start(PATIENT, "claude", None)
    with pytest.raises(ApiError) as caught:
        p.events("c1", "guessed", [ev("CallConnected")])
    assert caught.value.status == 404 and line.did == [("call", "+447403289357")]


def test_a_call_that_cannot_be_placed_ends_the_aftercare_call_and_says_why():
    p, agent, _ = phone(line=Line(fail=True))
    with pytest.raises(ApiError, match="no such number"):
        p.start(PATIENT, "claude", None)
    assert agent.ended == ["c1"]


def test_without_the_settings_the_page_is_told_what_is_missing():
    p = P.AftercarePhone(Aftercare([]), None, "", "", ["AFTERCARE_CALL_TO", "AFTERCARE_CALLER_ID"])
    assert p.info()["configured"] is False
    with pytest.raises(ApiError, match="AFTERCARE_CALL_TO, AFTERCARE_CALLER_ID"):
        p.start(PATIENT, "claude", None)


def test_older_patients_hear_a_slower_softer_voice_with_pauses():
    from xml.dom.minidom import parseString

    from backend.app.gateways import phone as G

    assert [G.pace_for_age(a) for a in (40, 64, 65, 79, 80, 92)] == ["normal", "normal", "slower", "slower",
                                                                         "slowest", "slowest"]
    ssml = G.ssml("Hello Margaret. Is that you? Tablets & <care> plan.", "en", "slowest")
    parseString(ssml)  # valid XML, so a reply with & or < cannot break it
    assert 'rate="-20%"' in ssml and 'volume="soft"' in ssml and ssml.count('<break time="600ms"/>') == 2
    assert "en-GB-SoniaNeural" in ssml and "&amp;" in ssml


def test_the_call_speaks_at_the_patients_pace(monkeypatch):
    p, _, line = phone()
    paces = []
    line.say_and_listen = lambda *a, **k: paces.append(a[-1] if len(a) > 5 else k.get("pace"))  # type: ignore
    p.start(PATIENT, "claude", None)  # P101, Margaret Bell, born 1946: over 80
    p.events("c1", token_of(line), [ev("CallConnected")])
    assert paces == ["slowest"]
