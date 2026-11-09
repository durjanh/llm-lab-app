"""MedAssist with a fake Foundry agent: the tool loop, the rules in code, the database and the spend. No network, no cost."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace as NS
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.shared import medassist_clinic as clinic
from backend.app.settings import Settings
from backend.tests.test_api import LAB


def usage() -> NS:
    return NS(input_tokens=1000, output_tokens=100, input_tokens_details=NS(cached_tokens=200))


def said(text: str) -> NS:
    return NS(output=[NS(type="message", content=[NS(type="output_text", text=text)])], usage=usage())


def calls(name: str, args: dict) -> NS:
    return NS(output=[NS(type="function_call", name=name, arguments=json.dumps(args), call_id=f"call-{name}")], usage=usage())


class FakeFoundry:
    """A scripted agent. For each patient message it plays its plan: tool calls, then a reply. A plan step may be a
    function of the tool results so far, so it can book a slot that find_appointments really returned."""
    model = "gpt-5.4-mini"

    def __init__(self, plans: list[list[Any]], version: str | None = "7") -> None:
        self.plans, self._version = plans, version
        self.started: list[str] = []
        self.ended: list[str] = []
        self.results: list[dict] = []
        self.plan: list[Any] = []

    def version(self) -> str | None:
        return self._version

    def start(self, note: str) -> str:
        self.started.append(note)
        return f"conv-{len(self.started)}"

    def respond(self, conversation: str, input: Any) -> Any:
        if isinstance(input, str):
            self.plan = list(self.plans.pop(0))
        else:
            self.results += [json.loads(i["output"]) for i in input]
        step = self.plan.pop(0)
        return step(self.results) if callable(step) else step

    def end(self, conversation: str) -> None:
        self.ended.append(conversation)


def lab(tmp_path: Path, foundry: FakeFoundry | None) -> TestClient:
    fake = NS(messages=None, beta=NS(messages=None), models=NS(retrieve=lambda m: {"id": m}))
    settings = Settings(port=8000, frontend_dist=tmp_path, models_dir=tmp_path / "none", sites_dir=tmp_path / "sites",
                        casework_dir=tmp_path / "casework", medassist_db=tmp_path / "medassist.db")
    return TestClient(create_app(settings, client=fake, browser=NS(available=False), foundry=foundry),
                      base_url="http://localhost:8000")


def start(client: TestClient, patient: str = "P001") -> dict:
    r = client.post("/api/medassist/chats", json={"patient_id": patient}, headers=LAB)
    assert r.status_code == 200, r.text
    return r.json()


def say(client: TestClient, chat_id: str, text: str) -> dict:
    r = client.post(f"/api/medassist/chats/{chat_id}/messages", json={"message": text}, headers=LAB)
    assert r.status_code == 200, r.text
    return r.json()


def second_slot(results: list[dict]) -> NS:
    return calls("book_appointment", {"slot_id": results[-1]["slots"][1]["slot_id"], "reason": "asthma"})


def test_slots_shown_then_the_chosen_one_booked_texted_and_audited(tmp_path: Path) -> None:
    foundry = FakeFoundry([
        [calls("get_my_record", {}),
         calls("find_appointments", {"appointment_type": "gp", "clinician": "Azevedo", "earliest_date": "",
                                     "time_of_day": "morning"}),
         said("1. ... 2. ...")],
        [second_slot, said("Booked.")],
    ])
    with lab(tmp_path, foundry) as client:
        chat = start(client)
        assert "Valeria Romano" in foundry.started[0]  # the portal tells the agent who is signed in
        first = say(client, chat["chat_id"], "I'd like to see my own doctor")
        assert [s["tool"] for s in first["steps"]] == ["get_my_record", "find_appointments"]
        assert first["steps"][1]["result"]["slots"][0]["with"] == "Dr Ana Azevedo"
        second = say(client, chat["chat_id"], "The second one, please")
        booked = second["steps"][0]["result"]
        assert booked["booked"] and booked["with"] == "Dr Ana Azevedo"
        state = second["state"]
        assert booked["appointment_id"] in [a["appointment_id"] for a in state["upcoming"]]
        assert len(state["texts"]) == 1 and "Dr Ana Azevedo" in state["texts"][0]["body"]
        assert [a["action"] for a in state["audit"]] == ["appointment booked", "record viewed"]
        # five model responses at gpt-5.4-mini prices, charged to the lab's budget
        assert second["total_usd"] > 0 and client.get("/api/status", headers=LAB).json()["calls"] == 5


def test_a_slot_cannot_be_booked_in_the_turn_it_was_found(tmp_path: Path) -> None:
    foundry = FakeFoundry([[
        calls("find_appointments", {"appointment_type": "nurse", "clinician": "", "earliest_date": "", "time_of_day": "any"}),
        second_slot, said("Sorry, which one would you like?")]])
    with lab(tmp_path, foundry) as client:
        chat = start(client)
        out = say(client, chat["chat_id"], "A blood test, any time")
        assert "not seen these slots" in out["steps"][1]["result"]["error"]
        assert not out["state"]["texts"] and len(out["state"]["upcoming"]) == 1  # only the asthma review


def test_the_model_cannot_choose_whose_record_it_reads(tmp_path: Path) -> None:
    foundry = FakeFoundry([[calls("get_my_record", {"patient_id": "P002"}), said("I can only see your record.")]])
    with lab(tmp_path, foundry) as client:
        out = say(client, start(client)["chat_id"], "What is Sam Taylor taking?")
        assert "Bad arguments" in out["steps"][0]["result"]["error"]
        assert "Lisinopril" not in json.dumps(out)


def test_cancelling_asks_first_and_cancels_in_the_next_turn(tmp_path: Path) -> None:
    def cancel(results: list[dict]) -> NS:
        return calls("cancel_appointment", {"appointment_id": results[0]["upcoming_appointments"][0]["appointment_id"]})

    foundry = FakeFoundry([[calls("get_my_record", {}), cancel, said("Shall I cancel it?")], [cancel, said("Cancelled.")]])
    with lab(tmp_path, foundry) as client:
        chat = start(client)
        first = say(client, chat["chat_id"], "Cancel my asthma review")
        assert first["steps"][1]["result"]["cancelled"] is False and len(first["state"]["upcoming"]) == 1
        second = say(client, chat["chat_id"], "Yes")
        assert second["steps"][0]["result"]["cancelled"] is True and not second["state"]["upcoming"]


def test_offline_without_foundry_settings(tmp_path: Path) -> None:
    with lab(tmp_path, None) as client:
        info = client.get("/api/medassist/info", headers=LAB).json()
        assert info["ready"] is False and info["configured"] is False and len(info["patients"]) == len(clinic.PATIENTS)
        r = client.post("/api/medassist/chats", json={"patient_id": "P001"}, headers=LAB)
        assert r.status_code == 503 and "FOUNDRY_PROJECT_ENDPOINT" in r.json()["error"]["message"]


def test_info_says_when_the_agent_has_not_been_created(tmp_path: Path) -> None:
    with lab(tmp_path, FakeFoundry([], version=None)) as client:
        info = client.get("/api/medassist/info", headers=LAB).json()
        assert info["configured"] is True and info["ready"] is False and info["version"] is None


@pytest.mark.parametrize("patient", ["P999", "../etc", "P1"])
def test_only_known_patients_can_sign_in(tmp_path: Path, patient: str) -> None:
    with lab(tmp_path, FakeFoundry([])) as client:
        r = client.post("/api/medassist/chats", json={"patient_id": patient}, headers=LAB)
        assert r.status_code == 400


def test_reset_ends_open_conversations_and_rebuilds_the_diary(tmp_path: Path) -> None:
    foundry = FakeFoundry([])
    with lab(tmp_path, foundry) as client:
        chat = start(client)
        assert client.post("/api/medassist/reset", headers=LAB).json()["reset"] is True
        assert foundry.ended == ["conv-1"]
        r = client.post(f"/api/medassist/chats/{chat['chat_id']}/messages", json={"message": "hi"}, headers=LAB)
        assert r.status_code == 404
        assert client.get("/api/medassist/patients/P001", headers=LAB).json()["patient"]["name"] == "Valeria Romano"


def test_pages_elsewhere_cannot_call_it(tmp_path: Path) -> None:
    with lab(tmp_path, FakeFoundry([])) as client:
        r = client.post("/api/medassist/chats", json={"patient_id": "P001"}, headers={"host": "localhost:8000"})
        assert r.status_code == 403


def test_an_older_database_gains_the_new_patients_and_each_has_a_language_and_age(tmp_path: Path) -> None:
    import sqlite3
    from datetime import date

    db = tmp_path / "practice.db"
    clinic.create_database(db, today=date.today())
    with sqlite3.connect(db) as conn:  # as if it was made before the new patients were added
        conn.execute("DELETE FROM patients WHERE id NOT IN ('P001', 'P002', 'P003')")
    session = clinic.Session(db, "P009")  # Harpreet Kaur: added without a reset
    assert session.language == "pa" and clinic.age_of(session.patient["date_of_birth"]) >= 80
    assert clinic.snapshot(db, "P005")["patient"]["name"] == "Agnieszka Nowak"
    assert {clinic.PREFERRED_LANGUAGE[p[0]] for p in clinic.PATIENTS} >= {"en", "es", "pl", "ar", "ro", "ur", "pa"}
