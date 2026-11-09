"""MedAssist on Agent Framework: the turn middleware that lets the clinic's rules work however the agent is called,
including from DevUI, which calls the agent itself. No model, no network: call_next stands in for the agent's run."""
from __future__ import annotations

import asyncio
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace as NS

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples" / "medassist"))

import clinic  # noqa: E402
import medassist_af  # noqa: E402


def run(middleware: medassist_af.NewTurn, conversation: str, step) -> None:
    """One patient message, as DevUI sends it: agent.run() with that conversation's session."""
    async def call_next() -> None:
        step()

    asyncio.run(middleware.process(NS(session=NS(session_id=conversation)), call_next))


def test_a_slot_shown_in_one_message_can_be_booked_in_the_next_when_devui_calls_the_agent(tmp_path: Path) -> None:
    clinic.create_database(tmp_path / "practice.db", today=date.today())
    session = clinic.Session(tmp_path / "practice.db", "P002")
    new_turn = medassist_af.NewTurn(session)
    shown: dict = {}

    run(new_turn, "devui-1", lambda: shown.update(session.find_appointments("gp", "", "", "any")))
    slot = shown["slots"][0]["slot_id"]
    booked: dict = {}
    run(new_turn, "devui-1", lambda: booked.update(session.book_appointment(slot, "review")))

    assert session.turn == 2
    assert booked.get("booked"), booked  # without the middleware: "the patient has not seen these slots yet"


def test_the_same_message_cannot_book_what_it_has_just_shown(tmp_path: Path) -> None:
    clinic.create_database(tmp_path / "practice.db", today=date.today())
    session = clinic.Session(tmp_path / "practice.db", "P002")
    result: dict = {}

    def find_and_book() -> None:
        slot = session.find_appointments("gp", "", "", "any")["slots"][0]["slot_id"]
        result.update(session.book_appointment(slot, "review"))

    run(medassist_af.NewTurn(session), "devui-1", find_and_book)
    assert "not seen these slots" in result["error"]


def test_a_new_devui_conversation_starts_the_rules_afresh(tmp_path: Path) -> None:
    clinic.create_database(tmp_path / "practice.db", today=date.today())
    session = clinic.Session(tmp_path / "practice.db", "P002")
    new_turn = medassist_af.NewTurn(session)
    shown: dict = {}
    run(new_turn, "devui-1", lambda: shown.update(session.find_appointments("gp", "", "", "any")))

    booked: dict = {}
    slot = shown["slots"][0]["slot_id"]
    run(new_turn, "devui-2", lambda: booked.update(session.book_appointment(slot, "review")))

    assert session.turn == 1  # counted from the start of the new conversation
    assert slot not in session.offered
    assert "offered in this conversation" in booked["error"]  # slots shown in another conversation do not count


def test_a_streamed_reply_keeps_its_pieces_and_drops_the_repeat_of_the_whole_text() -> None:
    def update(event: str, text: str) -> NS:
        return NS(raw_representation=NS(raw_representation=NS(type=event)), contents=[NS(type="text", text=text)])

    pieces = [update("response.output_text.delta", "Hi"), update("response.output_text.delta", " there")]
    repeat = update("response.output_text.done", "Hi there")
    shown = [c.text for u in [*pieces, repeat] for c in medassist_af.without_repeated_text(u).contents]

    assert "".join(shown) == "Hi there"


def test_file_search_reaches_devui_as_a_tool_call_with_its_result() -> None:
    call = medassist_af.Content.from_search_tool_call("fs_1", tool_name="file_search", arguments={"queries": ["Saturday"]})
    result = medassist_af.Content.from_search_tool_result("fs_1", tool_name="file_search", result={"results": ["09:00-12:00"]})
    text = medassist_af.Content.from_text("We open at 09:00.")

    shown = medassist_af.hosted_tools_as_calls(NS(contents=[call, result, text])).contents

    assert [c.type for c in shown] == ["function_call", "function_result", "text"]
    assert shown[0].name == "file_search" and shown[0].call_id == shown[1].call_id == "fs_1"
    assert shown[0].informational_only  # Foundry has already run it: nothing runs it again
