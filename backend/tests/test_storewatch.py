"""The shoplifting alert desk's rules. They live in the service, so the page can't get round them."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.main import create_app
from backend.app.services.storewatch import StoreWatchService
from backend.app.settings import Settings

NOTE = "Saw two bottles go into the coat on camera 3."


@pytest.fixture
def desk(tmp_path: Path) -> StoreWatchService:
    return StoreWatchService(tmp_path / "s.db")


def ready(desk: StoreWatchService) -> None:
    desk.set_compliance("The Shop Ltd", "Legitimate interests, see the DPIA", "DPIA-1", True)


def confirm(desk: StoreWatchService, alert_id: int) -> dict:
    return desk.review(alert_id, "Sam", True, NOTE, True)


def status(state: dict) -> list[str]:
    return [e["status"] for e in state["watchlist"]]


def test_a_high_score_alerts_the_admin_and_holds_the_face_but_lists_nobody(desk: StoreWatchService) -> None:
    state = desk.next_alert()
    assert status(state) == ["held"]
    assert state["notices"][0]["level"] == "high"


def test_a_held_face_cannot_trigger_the_door(desk: StoreWatchService) -> None:
    ready(desk)
    desk.next_alert()
    state = desk.next_visitor(80)  # S1
    state = desk.next_visitor(80)  # P1 comes back, and is only held
    assert state["matches"] == [] and state["visitors_discarded"] == 2


def test_a_person_confirming_makes_the_entry_live_and_the_door_matches(desk: StoreWatchService) -> None:
    ready(desk)
    desk.next_alert()
    assert status(confirm(desk, 1)) == ["active"]
    desk.next_visitor(80)
    state = desk.next_visitor(80)
    match = state["matches"][0]
    assert match["high"] == 1 and match["score"] >= 90 and "visitor" not in match  # staff aren't told the answer
    assert state["notices"][0]["level"] == "high"


def test_rejecting_a_high_score_deletes_the_held_face(desk: StoreWatchService) -> None:
    desk.next_alert()
    desk.next_alert()  # P2: a score of 93 for a phone going into a bag
    state = desk.review(2, "Sam", False, "", False)
    assert [e["person"] for e in state["watchlist"]] == ["P1"]
    assert state["high_score_rejected"] == 1


def test_a_low_score_holds_nothing(desk: StoreWatchService) -> None:
    for _ in range(3):
        state = desk.next_alert()
    assert len(state["watchlist"]) == 2 and len(state["alerts"]) == 3  # P3 scored 72


def test_nothing_is_confirmed_before_the_shop_has_recorded_its_basis(desk: StoreWatchService) -> None:
    desk.next_alert()
    with pytest.raises(ApiError) as caught:
        confirm(desk, 1)
    assert caught.value.status == 409
    with pytest.raises(ApiError):
        desk.next_visitor(80)


@pytest.mark.parametrize("note,watched", [(NOTE, False), ("Looks dodgy", True)])
def test_confirming_needs_the_footage_watched_and_a_reason(desk: StoreWatchService, note: str, watched: bool) -> None:
    ready(desk)
    desk.next_alert()
    with pytest.raises(ApiError):
        desk.review(1, "Sam", True, note, watched)


def test_a_look_alike_is_a_possible_match_that_staff_can_reject(desk: StoreWatchService) -> None:
    ready(desk)
    for _ in range(3):
        desk.next_alert()
    confirm(desk, 3)
    for _ in range(4):
        state = desk.next_visitor(80)
    match = state["matches"][0]
    assert match["high"] == 0 and 80 <= match["score"] < 90
    state = desk.decide_match(match["id"], "Sam", False)
    assert state["matches"][0]["status"] == "not_same" and state["matches"][0]["correct"] == 0


def test_a_face_nobody_reviewed_is_deleted_and_the_alert_expires(desk: StoreWatchService) -> None:
    desk.next_alert()
    state = desk.advance(4)
    assert state["watchlist"] == [] and state["alerts"][0]["status"] == "expired"


def test_a_live_entry_is_deleted_when_retention_ends(desk: StoreWatchService) -> None:
    ready(desk)
    desk.next_alert()
    confirm(desk, 1)
    assert status(desk.advance(89)) == ["active"]
    assert desk.advance(2)["watchlist"] == []


def test_someone_can_be_removed_from_the_list(desk: StoreWatchService) -> None:
    ready(desk)
    desk.next_alert()
    state = confirm(desk, 1)
    assert desk.remove(state["watchlist"][0]["id"], "Sam", "Erasure request")["watchlist"] == []


def test_the_routes_need_the_lab_page(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(generated_dir=tmp_path), client=object())) as client:
        assert client.get("/api/storewatch/state", headers={"host": "localhost:8000"}).status_code == 403
        assert client.get("/api/storewatch/state", headers={"x-llm-lab": "1", "host": "localhost:8000"}).status_code == 200
