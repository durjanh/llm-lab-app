"""The shoplifting alert desk's rules. They live in the service, so the page can't get round them."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.main import create_app
from backend.app.services.spend import SpendTracker
from backend.app.services.storewatch import StoreWatchService, follow_visit
from backend.app.settings import Settings

NOTE = "Saw two bottles go into the coat on camera 3."


@pytest.fixture
def desk(tmp_path: Path) -> StoreWatchService:
    return StoreWatchService(tmp_path / "s.db")


def confirm(desk: StoreWatchService, alert_id: int) -> dict:
    return desk.review(alert_id, "Sam", True, NOTE, True)


def status(state: dict) -> list[str]:
    return [e["status"] for e in state["watchlist"]]


def test_a_high_score_alerts_the_admin_and_holds_the_face_but_lists_nobody(desk: StoreWatchService) -> None:
    state = desk.next_alert()
    assert status(state) == ["held"]
    assert state["notices"][0]["level"] == "high"


def test_a_held_face_cannot_trigger_the_door(desk: StoreWatchService) -> None:
    desk.next_alert()
    state = desk.next_visitor(80)  # S1
    state = desk.next_visitor(80)  # P1 comes back, and is only held
    assert state["matches"] == [] and state["visitors_discarded"] == 2


def test_a_person_confirming_makes_the_entry_live_and_the_door_matches(desk: StoreWatchService) -> None:
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


def test_the_desk_runs_as_a_demo_with_no_gate_and_says_so_once_in_the_audit_log(desk: StoreWatchService) -> None:
    desk.state()
    desk.next_alert()
    state = desk.review(1, "Sam", True)  # one click: a named person, the note optional
    assert status(state) == ["active"] and state["watchlist"][0]["reason"] == "Confirmed from the footage."
    assert state["watchlist"][0]["added_by"] == "Sam"
    assert sum("Demo mode" in a["action"] for a in state["audit"]) == 1
    desk.next_visitor(80)  # the door needs no form either


def test_a_governance_record_is_optional_and_kept(desk: StoreWatchService) -> None:
    state = desk.set_compliance("The Shop Ltd", "Legitimate interests, see the DPIA", "DPIA-1", True)
    assert state["compliance"]["dpia_reference"] == "DPIA-1"


def test_a_look_alike_is_a_possible_match_that_staff_can_reject(desk: StoreWatchService) -> None:
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
    desk.next_alert()
    confirm(desk, 1)
    assert status(desk.advance(89)) == ["active"]
    assert desk.advance(2)["watchlist"] == []


def test_someone_can_be_removed_from_the_list(desk: StoreWatchService) -> None:
    desk.next_alert()
    state = confirm(desk, 1)
    assert desk.remove(state["watchlist"][0]["id"], "Sam", "Erasure request")["watchlist"] == []


def test_the_routes_need_the_lab_page(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(generated_dir=tmp_path), client=object())) as client:
        assert client.get("/api/storewatch/state", headers={"host": "localhost:8000"}).status_code == 403
        assert client.get("/api/storewatch/state", headers={"x-llm-lab": "1", "host": "localhost:8000"}).status_code == 200


class FakeVision:
    models = ["gpt-5.4-mini"]

    def __init__(self, score: int):
        self.score, self.seen, self.seen_next = score, [], {}

    def chat(self, model: str, messages: list[dict], **_: Any) -> tuple[Any, Any]:
        self.seen.append(messages)
        usage = SimpleNamespace(input_tokens=100, output_tokens=20, cache_read_input_tokens=0)
        seen = {"observed": "Hid a tin inside a coat.", "reasoning": "It went out of sight.", "score": self.score, **self.seen_next}
        return SimpleNamespace(content=json.dumps(seen)), usage


FRAME = "data:image/jpeg;base64,AAAA"
ME = [0.1] * 128
NEAR = [0.1 + 0.02 * (-1) ** i for i in range(128)]  # distance 0.226, a score of 97.4
FAR = [0.1 + 0.2 * (-1) ** i for i in range(128)]  # distance 2.26


def camera(tmp_path: Path, score: int) -> StoreWatchService:
    return StoreWatchService(tmp_path / "c.db", gpt=FakeVision(score), spend=SpendTracker(1.0))


def test_a_low_camera_score_keeps_nothing(tmp_path: Path) -> None:
    state = camera(tmp_path, 20).camera_analyse([FRAME], ME, FRAME)
    assert state["alerts"] == [] and state["watchlist"] == [] and state["last_camera"]["alerted"] is False


def test_a_high_camera_score_only_holds_and_a_person_makes_it_live(tmp_path: Path) -> None:
    desk = camera(tmp_path, 95)
    state = desk.camera_analyse([FRAME], ME, FRAME)
    assert status(state) == ["held"] and state["notices"][0]["level"] == "high"
    assert desk.camera_door(NEAR, 80)["matches"] == []  # held: can't match
    desk.review(1, "Sam", True, NOTE, True)
    state = desk.camera_door(NEAR, 80)
    assert state["matches"][0]["score"] == 97.4 and state["matches"][0]["thumbnail"] == FRAME


def test_the_camera_door_forgets_strangers_and_does_not_repeat_an_open_match(tmp_path: Path) -> None:
    desk = camera(tmp_path, 95)
    desk.camera_analyse([FRAME], ME, FRAME)
    desk.review(1, "Sam", True, NOTE, True)
    assert desk.camera_door(FAR, 80)["visitors_discarded"] == 1
    desk.camera_door(NEAR, 80)
    assert len(desk.camera_door(NEAR, 80)["matches"]) == 1


def test_rejecting_or_removing_deletes_the_footage_and_face(tmp_path: Path) -> None:
    desk = camera(tmp_path, 95)
    desk.camera_analyse([FRAME], ME, FRAME)
    desk.review(1, "Sam", False, "", False)
    with desk._db() as db:
        assert db.execute("SELECT COUNT(*) n FROM media").fetchone()["n"] == 0


def test_footage_nobody_reviews_is_deleted(tmp_path: Path) -> None:
    desk = camera(tmp_path, 60)
    desk.camera_analyse([FRAME], ME, FRAME)
    state = desk.advance(4)
    assert state["alerts"][0]["status"] == "expired"
    with desk._db() as db:
        assert db.execute("SELECT COUNT(*) n FROM media").fetchone()["n"] == 0


def test_an_alert_with_no_face_cannot_add_anyone(tmp_path: Path) -> None:
    desk = camera(tmp_path, 95)
    desk.camera_analyse([FRAME], None, None)
    with pytest.raises(ApiError):
        desk.review(1, "Sam", True, NOTE, True)


VISIT = {"log": [], "carrying": False}


@pytest.mark.parametrize("steps,left_unpaid", [
    ([{"picked_up": True}, {"left_exit": True}], True),
    ([{"concealed": True}, {"left_exit": True}], True),
    ([{"picked_up": True}, {"paid": True}, {"left_exit": True}], False),
    ([{"picked_up": True}, {"put_back": True}, {"left_exit": True}], False),
    ([{"left_exit": True}], False),
    ([{"picked_up": True, "paid": True}, {"left_exit": True}], False),
])
def test_following_a_visit(steps: list[dict], left_unpaid: bool) -> None:
    visit, left = VISIT, False
    for seen in steps:
        visit, left = follow_visit(visit, seen)
    assert left is left_unpaid


def test_leaving_with_an_item_alerts_and_holds_even_if_the_model_scored_it_low(tmp_path: Path) -> None:
    desk = camera(tmp_path, 10)
    desk.gpt.seen_next = {"picked_up": True}
    assert desk.camera_analyse([FRAME], ME, FRAME)["alerts"] == []  # picking something up is normal
    desk.gpt.seen_next = {"left_exit": True}
    state = desk.camera_analyse([FRAME], ME, FRAME)
    assert state["last_camera"]["left_unpaid"] is True and status(state) == ["held"]  # held for a person, never live


def test_the_model_is_told_what_happened_earlier(tmp_path: Path) -> None:
    desk = camera(tmp_path, 10)
    desk.gpt.seen_next = {"observed": "Took a tin from the shelf."}
    desk.camera_analyse([FRAME], ME, FRAME)
    desk.camera_analyse([FRAME], ME, FRAME)
    assert "Took a tin from the shelf." in desk.gpt.seen[1][0]["content"]


def test_leaving_ends_the_visit(tmp_path: Path) -> None:
    desk = camera(tmp_path, 10)
    desk.gpt.seen_next = {"picked_up": True, "left_exit": True}
    assert desk.camera_analyse([FRAME], ME, FRAME)["camera_visit"]["carrying"] is False



EVENTS = ["12:01:04 Person 3 picked up a bottle", "12:01:09 Person 3: the bottle went out of sight at the hip"]


def test_the_model_is_called_with_the_trackers_events_and_the_rules_are_kept_on_the_alert(tmp_path: Path) -> None:
    desk = camera(tmp_path, 80)
    state = desk.camera_analyse([FRAME] * 5, ME, FRAME, None, EVENTS, ["possible_concealment", "made_up_rule"], 3)
    system = desk.gpt.seen[0][0]["content"]
    assert EVENTS[1] in system and "It can be wrong" in system and "never as something you saw" in system
    alert = state["alerts"][0]
    assert alert["rules"] == ["possible_concealment"] and alert["source"] == "model" and alert["reasoning"] == "It went out of sight."
    assert state["last_camera"]["alert_id"] == alert["id"] and state["camera_calls"] == 1 and state["camera_spent_usd"] > 0


def test_each_tracked_person_has_their_own_visit(tmp_path: Path) -> None:
    desk = camera(tmp_path, 10)
    desk.gpt.seen_next = {"picked_up": True}
    desk.camera_analyse([FRAME], ME, FRAME, track=1)
    desk.gpt.seen_next = {"left_exit": True}
    assert desk.camera_analyse([FRAME], ME, FRAME, track=2)["alerts"] == []  # person 2 picked nothing up
    assert desk.camera_analyse([FRAME], ME, FRAME, track=1)["last_camera"]["left_unpaid"] is True


def test_the_rules_alone_score_when_there_is_no_model_or_it_is_switched_off(tmp_path: Path) -> None:
    desk = StoreWatchService(tmp_path / "r.db")
    assert desk.camera_analyse([FRAME], ME, FRAME, events=EVENTS, rules=["long_dwell"])["alerts"] == []
    state = desk.camera_analyse([FRAME], ME, FRAME, events=EVENTS, rules=["possible_concealment"])
    assert state["alerts"][0]["score"] == 72 and state["alerts"][0]["source"] == "rules" and state["watchlist"] == []
    state = desk.camera_analyse([FRAME], ME, FRAME, events=EVENTS, rules=["left_without_paying"], track=2)
    assert status(state) == ["held"] and state["last_camera"]["modelled"] is False
    modelled = camera(tmp_path, 95)
    modelled.camera_analyse([FRAME], ME, FRAME, rules=["possible_concealment"], use_model=False)
    assert modelled.gpt.seen == []  # nothing went to the cloud


WEBM = b"\x1a\x45\xdf\xa3" + b"0" * 64


def test_a_clip_is_a_file_on_disk_and_goes_when_the_footage_goes(tmp_path: Path) -> None:
    desk = camera(tmp_path, 95)
    alert_id = desk.camera_analyse([FRAME], ME, FRAME)["last_camera"]["alert_id"]
    state = desk.attach_clip(alert_id, WEBM, 4.5)
    alert = state["alerts"][0]
    name = alert["clip"].rsplit("/", 1)[1]
    assert alert["clip_start"] == 4.5 and (tmp_path / "clips" / name).read_bytes() == WEBM
    assert desk.clip_file(name)[1] == "video/webm"
    with desk._db() as db:  # the clip is not in the database
        assert WEBM.hex() not in str(db.execute("SELECT * FROM media").fetchone()[:])
    desk.attach_clip(alert_id, WEBM)  # a second upload replaces the first
    assert len(list((tmp_path / "clips").iterdir())) == 1
    desk.review(alert_id, "Sam", False)
    assert list((tmp_path / "clips").iterdir()) == []
    with pytest.raises(ApiError):
        desk.clip_file(name)
    with pytest.raises(ApiError):
        desk.attach_clip(alert_id, WEBM)  # decided: it keeps no footage


@pytest.mark.parametrize("how", ["expiry", "removal", "reset"])
def test_expiry_removal_and_reset_delete_the_clip_file(tmp_path: Path, how: str) -> None:
    desk = camera(tmp_path, 95)
    desk.camera_analyse([FRAME], ME, FRAME)
    desk.attach_clip(1, WEBM)
    if how == "expiry":
        desk.advance(4)
    elif how == "removal":
        state = desk.review(1, "Sam", True)
        assert state["alerts"][0]["status"] == "confirmed"
        desk.remove(state["watchlist"][0]["id"], "Sam", "Erasure request")
    else:
        desk.reset()
    assert list((tmp_path / "clips").iterdir()) == []


def test_a_clip_must_be_a_video_and_its_name_cannot_leave_the_folder(tmp_path: Path) -> None:
    desk = camera(tmp_path, 95)
    desk.camera_analyse([FRAME], ME, FRAME)
    with pytest.raises(ApiError):
        desk.attach_clip(1, b"<html>not a video</html>")
    for name in ("../s.db", "1-zzzzzzzzzzzz.webm", "c.db"):
        with pytest.raises(ApiError):
            desk.clip_file(name)


def test_clips_upload_through_the_guarded_route_and_play_without_the_header(tmp_path: Path) -> None:
    lab = {"x-llm-lab": "1", "host": "localhost:8000"}
    with TestClient(create_app(Settings(generated_dir=tmp_path), client=object(), gpt=FakeVision(95))) as client:
        body = {"frames": [FRAME], "descriptor": ME, "thumbnail": FRAME, "events": EVENTS, "rules": ["possible_concealment"], "track": 1}
        alert_id = client.post("/api/storewatch/camera/analyse", headers=lab, json=body).json()["last_camera"]["alert_id"]
        files = {"file": ("clip.webm", WEBM, "video/webm")}
        assert client.post(f"/api/storewatch/alerts/{alert_id}/clip", headers={"host": "localhost:8000"}, files=files).status_code == 403
        state = client.post(f"/api/storewatch/alerts/{alert_id}/clip", headers=lab, files=files, data={"start_s": "2"}).json()
        played = client.get(state["alerts"][0]["clip"], headers={"host": "localhost:8000"})
        assert played.status_code == 200 and played.content == WEBM and played.headers["content-type"] == "video/webm"
        assert client.post("/api/storewatch/camera/analyse", headers=lab, json={**body, "frames": [FRAME] * 7}).status_code in (400, 422)
