"""Aftercare: the ward's rules on their own, then both engines through the API with a scripted Claude and a fake
Agent Framework. No network."""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from anthropic.types import Message
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.settings import Settings
from backend.app.shared import aftercare_ward as ward
from backend.tests.test_api import LAB, FakeClient


@pytest.fixture
def db(tmp_path: Path) -> Path:
    path = tmp_path / "ward.db"
    ward.create_database(path)
    return path


def verified(db: Path, patient_id: str = "P101") -> ward.Call:
    call = ward.Call(db, patient_id)
    call.patient_input(ward.BY_ID[patient_id]["dob"])
    assert call.call("verify_identity", {"date_of_birth": ward.BY_ID[patient_id]["dob"]})["verified"]
    call.call("get_discharge_plan", {})
    return call


def test_lace_and_routing() -> None:
    assert ward.lace(6, True, 3, 2) == {"score": 12, "band": "high", "parts": {"L": 4, "A": 3, "C": 3, "E": 2}}
    assert ward.lace(1, False, 5, 9)["parts"] == {"L": 1, "A": 0, "C": 5, "E": 4}
    assert ward.route(80) == "voice" and ward.route(40) == "sms" and ward.route(80, "sms") == "sms"
    assert ward.wave_for(2) == 1 and ward.wave_for(28) == 2


def test_nothing_about_the_patient_before_identity(db: Path) -> None:
    call = ward.Call(db, "P101")
    assert "Margaret" in call.opening_note() and "Bell" not in call.opening_note()
    assert "heart" not in call.opening_note().lower() and "furosemide" not in call.opening_note().lower()
    assert "error" in call.call("get_discharge_plan", {})
    for attempt in range(3):
        out = call.call("verify_identity", {"date_of_birth": "1950-01-01"})
    assert out["locked"] and "error" in call.call("get_discharge_plan", {})
    assert call.call("finish_outreach", {"summary": "Could not verify.", "patient_ended": False})["status"] == "not_verified"


def test_answers_must_quote_the_patients_latest_message(db: Path) -> None:
    call = verified(db)
    args = {"medication": "Furosemide", "status": "not_collected", "detail": "chemist shut", "quote": "the chemist was shut"}
    assert "has not answered" in call.call("record_medication", args)["error"]  # same turn the plan was read
    call.patient_input("I never got the new tablets, the chemist was shut.")
    assert "copied exactly" in call.call("record_medication", {**args, "quote": "Patient has not answered yet"})["error"]
    out = call.call("record_medication", args)
    assert out["raised"] == {"queue": "pharmacist", "urgency": "urgent"}  # furosemide is high risk


def test_a_stopped_medicine_still_taken_goes_to_a_pharmacist(db: Path) -> None:
    call = verified(db, "P103")
    call.patient_input("Sí, sigo tomando la gliclazida.")
    call.call("record_medication", {"medication": "Gliclazide", "status": "taking_as_prescribed",
                                    "detail": "still taking it", "quote": "sigo tomando la gliclazida"})
    [task] = ward.queue(db)
    assert task["queue"] == "pharmacist" and task["urgency"] == "urgent" and "Gliclazide" in task["reason"]


def test_warning_signs_escalate_by_code_not_by_the_model(db: Path) -> None:
    call = verified(db)
    call.patient_input("My weight is up 3 kg and I have chest pain.")
    assert ward.queue(db)[0]["source"] == "screen"  # the emergency words were caught before any model saw them
    out = call.call("record_symptoms", {"warning_signs": ["weight_gain", "chest_pain"], "patient_words": "weight up, chest pain",
                                        "quote": "weight is up 3 kg"})
    assert "999" in out["tell_patient"]
    signs = [t for t in ward.queue(db) if t["source"] == "rule"]
    assert len(signs) == 1 and signs[0]["urgency"] == "emergency" and "weight up" in signs[0]["reason"]
    assert "error" in call.call("record_symptoms", {"warning_signs": ["made_up"], "patient_words": "", "quote": "chest pain"})


def test_the_screen_skips_a_negated_phrase_but_not_a_new_clause() -> None:
    assert ward.screen("No chest pain, just tired.") == ""
    assert ward.screen("I haven't had any chest pain") == ""
    assert ward.screen("No tengo dolor en el pecho") == ""
    assert ward.screen("No, I've got chest pain") == "chest pain"
    assert ward.screen("Not really, but I can't breathe") == "can't breathe"


def test_after_an_emergency_every_reply_carries_the_999_line(db: Path) -> None:
    call = ward.Call(db, "P103")
    model_input = call.patient_input("Me duele el pecho mucho")
    assert "Safety system" in model_input
    assert call.agent_output("Lo siento mucho.").endswith(ward.SAFETY_LINE["es"])
    assert call.agent_output("Llame al 999 ahora.") == "Llame al 999 ahora."  # already there: nothing added


def test_booking_needs_the_patient_to_have_seen_the_slot(db: Path) -> None:
    call = verified(db, "P102")
    call.patient_input("An afternoon phone call please")
    slots = call.call("find_follow_up", {"mode": "phone", "earliest_date": "", "time_of_day": "afternoon"})["slots"]
    assert all(s["mode"] == "phone" for s in slots)
    assert "not seen" in call.call("book_follow_up", {"slot_id": slots[0]["slot_id"]})["error"]
    assert "error" in call.call("book_follow_up", {"slot_id": "HFN-0101-0930"})  # never offered
    call.patient_input("The first one")
    assert call.call("book_follow_up", {"slot_id": slots[0]["slot_id"]})["booked"]
    assert ward.record(db, "P102")["texts"][0]["body"].startswith(ward.HOSPITAL)


def test_finishing_needs_the_checklist_and_an_english_note(db: Path) -> None:
    call = verified(db, "P102")
    out = call.call("finish_outreach", {"summary": "Patient is well.", "patient_ended": False})
    assert "still to cover" in out["error"] and "warning signs" in out["error"]
    out = call.call("finish_outreach", {"summary": "La paciente está bien y no tiene problemas con la medicación.",
                                        "patient_ended": True})
    assert "English" in out["error"]
    assert call.call("finish_outreach", {"summary": "Patient stopped the call.", "patient_ended": True})["status"] == "incomplete"
    assert any("ended early" in t["reason"] for t in ward.queue(db))
    assert call.call("get_discharge_plan", {})["error"] == "The call has ended."


def test_wave_two_asks_about_since_discharge_instead_of_booking(db: Path) -> None:
    call = verified(db, "P106")
    assert call.wave == 2 and "since discharge" in call.remaining() and "follow-up appointment" not in call.remaining()
    assert "error" in call.call("find_follow_up", {"mode": "any", "earliest_date": "", "time_of_day": "any"})
    call.patient_input("Yes I went, and I was in A&E once with a nosebleed")
    call.call("record_since_discharge", {"attended_follow_up": "yes", "emergency_visits": 1, "readmitted": False,
                                         "detail": "nosebleed", "quote": "A&E once with a nosebleed"})
    assert any("1 A&E visit" in t["reason"] for t in ward.queue(db))


# ---------- through the API ----------

def reply(model: str, *blocks: dict, stop: str = "end_turn") -> Message:
    return Message.model_validate({"id": "msg_test", "type": "message", "role": "assistant", "model": model,
                                   "content": list(blocks), "stop_reason": stop, "stop_sequence": None,
                                   "usage": {"input_tokens": 1000, "output_tokens": 100}})


class ScriptedClient(FakeClient):
    """Answers each Messages API request with the next scripted reply."""

    def __init__(self, script: list[list[dict]]) -> None:
        super().__init__()
        self.script = script

        def create(**params: Any) -> Message:
            self.calls.append(("messages.create", params))
            blocks = self.script.pop(0)
            return reply(params["model"], *blocks, stop="tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn")

        self.messages.create = create  # type: ignore[method-assign]


def text(t: str) -> dict:
    return {"type": "text", "text": t}


def use(name: str, args: dict, i: int = 1) -> dict:
    return {"type": "tool_use", "id": f"toolu_{name}_{i}", "name": name, "input": args}


class FakeAgents:
    """Agent Framework stand-in: each respond() runs the scripted tool calls, then answers."""
    model = "gpt-5.4-mini"

    def __init__(self, script: list[tuple[list[tuple[str, dict]], str]]) -> None:
        self.script, self.runs = script, 0

    def start(self, name: str, instructions: str, tools: list[dict], run_tool: Any) -> Any:
        assert "verify_identity" in {t["name"] for t in tools} and "Aftercare" in instructions
        return run_tool

    def respond(self, run_tool: Any, text: str) -> tuple[str, dict]:
        calls, answer = self.script.pop(0)
        for name, args in calls:
            run_tool(name, args)
        return answer, {"input_token_count": 2000, "output_token_count": 100}


def lab(tmp_path: Path, client: FakeClient, agents: Any = None, budget: float = 2.0) -> TestClient:
    settings = Settings(port=8000, budget_usd=budget, frontend_dist=tmp_path, models_dir=tmp_path / "none",
                        sites_dir=tmp_path / "sites", casework_dir=tmp_path / "casework",
                        aftercare_db=tmp_path / "aftercare" / "aftercare.db")
    return TestClient(create_app(settings, client=client, agents=agents), base_url="http://localhost:8000")


def test_a_claude_call_runs_our_tool_loop_and_writes_back(tmp_path: Path) -> None:
    client = ScriptedClient([
        [text("Hello Margaret, this is Harbourside General Hospital. Can you tell me your date of birth?")],
        [use("verify_identity", {"date_of_birth": "1946-03-12"})],
        [use("get_discharge_plan", {}, 2)],
        [text("Thank you. Have you collected your furosemide?")],
    ])
    api = lab(tmp_path, client)
    started = api.post("/api/aftercare/calls", json={"patient_id": "P101"}, headers=LAB).json()
    assert started["wave"] == 1 and started["channel"] == "voice" and "date of birth" in started["reply"]
    opening = client.calls[0][1]
    assert opening["tools"][-1]["cache_control"] == {"type": "ephemeral"} and "Bell" not in json.dumps(opening["messages"])
    out = api.post(f"/api/aftercare/calls/{started['call_id']}/messages", json={"message": "12 March 1946"}, headers=LAB).json()
    assert [s["tool"] for s in out["steps"]] == ["verify_identity", "get_discharge_plan"]
    assert out["steps"][1]["result"]["medicines"][0]["name"] == "Furosemide"
    assert out["cost_usd"] > 0 and "identity" not in out["checklist_left"]
    assert [a["action"] for a in out["record"]["audit"]][:2] == ["discharge plan viewed", "identity confirmed"]
    assert api.get("/api/status").json()["spent_usd"] > 0


def test_agent_framework_runs_the_same_tools_under_the_same_rules(tmp_path: Path) -> None:
    agents = FakeAgents([
        ([], "Hola Lucía, ¿me dice su fecha de nacimiento?"),
        ([("verify_identity", {"date_of_birth": "1959-11-23"}), ("get_discharge_plan", {}),
          ("record_medication", {"medication": "Gliclazide", "status": "unsure", "detail": "", "quote": "1959"})],
         "Gracias. ¿Sigue tomando la gliclazida?"),
    ])
    api = lab(tmp_path, FakeClient(), agents)
    started = api.post("/api/aftercare/calls", json={"patient_id": "P103", "engine": "agent-framework"}, headers=LAB).json()
    assert started["model"] == "gpt-5.4-mini"
    out = api.post(f"/api/aftercare/calls/{started['call_id']}/messages", json={"message": "23 noviembre 1959"},
                   headers=LAB).json()
    assert out["steps"][2]["result"]["error"].startswith("Not recorded")  # recorded in the turn the plan was read
    assert out["record"]["outreach"][0]["engine"] == "agent-framework" and out["cost_usd"] > 0


def test_the_evaluation_streams_each_patient_and_checks_the_record(tmp_path: Path) -> None:
    client = ScriptedClient([
        [text("Hola, le llamo del hospital. ¿Me puede decir su fecha de nacimiento?")],
        [text("Soy Carmen, la vecina. No sé la fecha.")],  # the simulated patient
        [use("finish_outreach", {"summary": "A neighbour answered; nothing shared.", "patient_ended": True})],
        [text("Gracias, Carmen. El hospital volverá a llamar a Rosa.")],
    ])
    api = lab(tmp_path, client)
    lines = [json.loads(line) for line in api.post("/api/aftercare/evaluate", json={"patients": ["P107"]},
                                                     headers=LAB).text.splitlines() if line.strip()]
    kinds = [e["type"] for e in lines]
    assert kinds[0] == "run" and kinds[-1] == "done" and "result" in kinds
    result = next(e for e in lines if e["type"] == "result")
    assert result["status"] == "not_verified" and all(c["passed"] for c in result["checks"])
    assert lines[-1]["passed"] == lines[-1]["total"] == 3


def test_refusals(tmp_path: Path) -> None:
    api = lab(tmp_path, FakeClient())
    assert api.post("/api/aftercare/calls", json={"patient_id": "P101", "engine": "agent-framework"},
                    headers=LAB).status_code == 503  # no Foundry project configured
    assert api.post("/api/aftercare/calls", json={"patient_id": "P101", "engine": "other"}, headers=LAB).status_code == 400
    assert api.post("/api/aftercare/calls", json={"patient_id": "P101", "model": "gpt-4"}, headers=LAB).status_code == 400
    assert api.post("/api/aftercare/calls/nope/messages", json={"message": "hi"}, headers=LAB).status_code == 404
    assert api.post("/api/aftercare/calls", json={"patient_id": "P101"}).status_code == 403  # not from a lab page
    assert lab(tmp_path, FakeClient(), budget=0).post("/api/aftercare/calls", json={"patient_id": "P101"},
                                                      headers=LAB).status_code == 429


def test_nurses_close_tasks_and_reset_starts_again(tmp_path: Path) -> None:
    api = lab(tmp_path, FakeClient())
    path = tmp_path / "aftercare" / "aftercare.db"
    api.get("/api/aftercare/info", headers=LAB)
    call = ward.Call(path, "P104")
    call.task("care navigator", "routine", "Barrier (transport): no car")
    [task] = api.get("/api/aftercare/board", headers=LAB).json()["queue"]
    assert api.post(f"/api/aftercare/tasks/{task['id']}/close", json={"note": "Transport booked"}, headers=LAB).json()["queue"] == []
    assert api.post(f"/api/aftercare/tasks/{task['id']}/close", json={}, headers=LAB).status_code == 404
    assert ward.record(path, "P104")["audit"][0]["action"] == "task closed"
    assert api.post("/api/aftercare/reset", headers=LAB).json()["queue"] == []
    assert date.fromisoformat(api.get("/api/aftercare/patients/P104", headers=LAB).json()["patient"]["discharged_on"]) < date.today()


class FakeLine:
    """A phone line that records what it was asked to do; nothing is rung."""

    def __init__(self) -> None:
        self.did: list[tuple] = []
        self.callback = ""

    def call(self, to: str, callback_url: str) -> str:
        self.callback = callback_url
        return "conn-1"

    def say_and_listen(self, connection_id: str, to: str, text: str, language: str, context: str, pace: str = "normal") -> None:
        self.did.append(("ask", text))

    def say(self, connection_id: str, text: str, language: str, context: str, pace: str = "normal") -> None:
        self.did.append(("say", text))

    def hang_up(self, connection_id: str) -> None:
        self.did.append(("hang up",))


def test_a_real_phone_call_and_an_emergency_on_it_are_in_the_patients_record(tmp_path: Path, monkeypatch) -> None:
    import threading
    from urllib.parse import parse_qs, urlsplit

    class Now(threading.Thread):  # the turn runs at once, so the record can be read straight after
        def start(self) -> None:
            self.run()

    monkeypatch.setattr("backend.app.services.aftercare_phone.threading.Thread", Now)
    client = ScriptedClient([
        [text("Hello Margaret, this is Harbourside General Hospital. Can you tell me your date of birth?")],
        [text("Please call 999 now. I have alerted the care team.")],
    ])
    line = FakeLine()
    settings = Settings(port=8000, budget_usd=2.0, frontend_dist=tmp_path, models_dir=tmp_path / "none",
                        sites_dir=tmp_path / "sites", casework_dir=tmp_path / "casework",
                        aftercare_db=tmp_path / "aftercare" / "aftercare.db", aftercare_call_to="07403 289357",
                        aftercare_callback_url="https://tunnel.example")
    api = TestClient(create_app(settings, client=client, phone=line), base_url="http://localhost:8000")
    started = api.post("/api/aftercare/phone", json={"patient_id": "P101"}, headers=LAB).json()
    call_id, token = started["call_id"], parse_qs(urlsplit(line.callback).query)["token"][0]
    events = f"/api/aftercare/phone/events/{call_id}?token={token}"
    api.post(events, json=[{"type": "Microsoft.Communication.CallConnected", "data": {}}])
    api.post(events, json=[{"type": "Microsoft.Communication.RecognizeCompleted",
                            "data": {"speechResult": {"speech": "I've got crushing chest pain right now."}}}])
    api.post(events, json=[{"type": "Microsoft.Communication.CallDisconnected", "data": {}}])
    record = api.get(f"/api/aftercare/phone/{call_id}", headers=LAB).json()["record"]
    said = [(t["speaker"], t["text"]) for t in record["transcript"]]
    assert ("patient", "I've got crushing chest pain right now.") in said  # what was said on the phone
    assert any(s == "agent" and "999" in t for s, t in said)  # and the agent's 999 reply
    assert any(t["urgency"] == "emergency" for t in record["tasks"])  # the emergency, raised by code
    actions = [a["action"] for a in record["audit"]]
    assert {"phone call placed", "phone call answered", "phone call ended"} <= set(actions)
    assert any("999" in d[1] for d in line.did if d[0] in ("ask", "say"))  # and it was spoken on the call


def test_a_page_conversation_is_kept_line_by_line_and_a_reset_keeps_the_database(tmp_path: Path) -> None:
    import json

    client = ScriptedClient([
        [text("Hello Margaret, this is Harbourside General Hospital. Can you tell me your date of birth?")],
        [text("Thank you. How are you feeling today?")],
    ])
    api = lab(tmp_path, client)
    call = api.post("/api/aftercare/calls", json={"patient_id": "P101"}, headers=LAB).json()
    api.post(f"/api/aftercare/calls/{call['call_id']}/messages", json={"message": "Twelfth of March 1946"}, headers=LAB)
    kept = [json.loads(l) for f in (tmp_path / "transcripts" / "aftercare").rglob("*.jsonl") for l in f.read_text().splitlines()]
    assert [(k["speaker"], k["text"][:20]) for k in kept] == [("agent", "Hello Margaret, this"),
                                                            ("patient", "Twelfth of March 194"),
                                                            ("agent", "Thank you. How are y")]
    api.post("/api/aftercare/reset", headers=LAB)
    assert list((tmp_path / "transcripts" / "databases").glob("aftercare-*.db"))  # kept before it was rebuilt


def test_romanian_emergencies_are_caught_and_a_denial_is_not() -> None:
    assert ward.screen("Mă doare pieptul și nu pot să respir.") == "mă doare pieptul"
    assert ward.screen("ma doare pieptul") == "ma doare pieptul"  # typed without diacritics
    assert ward.screen("Am leșinat azi dimineață.") == "am leșinat"
    assert ward.screen("Nu, nu pot respira!") == "nu pot respira"  # the comma starts a new clause
    assert ward.screen("Nu am dureri în piept.") == ""  # a denial
    assert ward.screen("Mă simt bine, mulțumesc.") == ""


def test_a_romanian_patient_is_followed_up_in_romanian_with_the_999_line_in_romanian(db: Path) -> None:
    call = verified(db, "P109")
    assert call.language == "ro" and ward.LANGUAGES["ro"] == "Romanian"
    call.patient_input("Mă doare pieptul tare.")
    assert call.agent_output("Bine, mulțumesc.").endswith(ward.SAFETY_LINE["ro"])  # added by code, in Romanian
