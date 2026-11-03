"""The deck builder, against a scripted fake Claude client: no network, no API key, no cost."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from backend.app.core.errors import ApiError
from backend.app.services.decks import REVIEW_ROUNDS, SYSTEM, Upload
from backend.tests.test_agents import reply
from backend.tests.test_api import LAB, make_client

PNG = b"\x89PNG\r\n\x1a\n"
SAME_IMAGE = {"file_v2s1": "file_s1"}  # the fix in v2 leaves slide 1 looking exactly as before
NAMES = {"file_deck": "results.pptx", "file_s1": "results-slide-01.png", "file_s2": "results-slide-02.png",
         "file_deck2": "results-v2.pptx", "file_v2s1": "results-v2-slide-01.png", "file_v2s2": "results-v2-slide-02.png"}


def made(*file_ids: str, text: str = "1. Title\n2. Results") -> Any:
    """Claude runs code in the container that saves these files, then says something."""
    return reply([
        {"type": "server_tool_use", "id": "srvtoolu_1", "name": "bash_code_execution", "input": {"command": "python build.py"}},
        {"type": "bash_code_execution_tool_result", "tool_use_id": "srvtoolu_1", "content": {
            "type": "bash_code_execution_result", "stdout": "saved", "stderr": "", "return_code": 0,
            "content": [{"type": "bash_code_execution_output", "file_id": i} for i in file_ids]}},
        {"type": "text", "text": text},
    ], "end_turn")


def says(text: str) -> Any:
    return reply([{"type": "text", "text": text}], "end_turn")


BUILT = made("file_deck", "file_s2", "file_s1")  # out of order on purpose
LOOKS_RIGHT = says("1. Title\n2. Results")


class FakeFiles:
    def __init__(self) -> None:
        self.uploaded: list[tuple[str, bytes, str, int]] = []
        self.deleted: list[str] = []

    def upload(self, *, file: tuple[str, bytes, str], expires_in_seconds: int) -> Any:
        self.uploaded.append((*file, expires_in_seconds))
        return SimpleNamespace(id=f"file_up{len(self.uploaded)}")

    def delete(self, file_id: str) -> None:
        self.deleted.append(file_id)

    def retrieve_metadata(self, file_id: str) -> Any:
        return SimpleNamespace(filename=NAMES[file_id], size_bytes=2048)

    def download(self, file_id: str) -> Any:
        image = PNG + SAME_IMAGE.get(file_id, file_id).encode()
        return SimpleNamespace(read=lambda: image if NAMES[file_id].endswith(".png") else b"pptx!")


class FakeMessages:
    """Replies from a script; once it runs out, every message is answered with LOOKS_RIGHT."""

    def __init__(self, *replies: Any) -> None:
        self.replies = list(replies)
        self.calls: list[dict] = []

    def create(self, **params: Any) -> Any:
        self.calls.append({**params, "messages": list(params["messages"])})  # a copy: the history keeps growing
        return self.replies.pop(0) if self.replies else LOOKS_RIGHT


def fake_client(*replies: Any) -> Any:
    return SimpleNamespace(messages=FakeMessages(*replies), files=FakeFiles(),
                           models=SimpleNamespace(retrieve=lambda model: {"id": model}))


@pytest.fixture
def fake() -> Any:
    return fake_client(BUILT, LOOKS_RIGHT, BUILT, LOOKS_RIGHT)


def turn(client, data: dict, files: list | None = None):
    r = client.post("/api/decks/turn", data=data, files=files or [], headers=LAB)
    return r, [json.loads(line) for line in r.text.splitlines() if line.strip()] if r.status_code == 200 else []


def test_first_turn_uploads_files_into_the_container_and_returns_the_deck(fake: Any, tmp_path: Path) -> None:
    client = make_client(fake, tmp_path)
    r, ev = turn(client, {"prompt": "Five slides on Q3 results"},
                 [("files", ("q3.csv", b"month,sales\nJul,10\n", "text/csv")),
                  ("template", ("brand.pptx", b"PK-template", "application/octet-stream"))])
    assert r.status_code == 200
    assert [e["type"] for e in ev] == ["run", "chat", "upload", "upload", "request", "step", "output", "says",
                                       "review", "request", "says", "files"]
    assert [u[0] for u in fake.files.uploaded] == ["q3.csv", "brand.pptx"]
    assert fake.files.uploaded[1][2].endswith("presentationml.presentation") and fake.files.uploaded[0][3] == 86400
    params = fake.messages.calls[0]
    assert params["system"] == SYSTEM
    assert params["container"] == {"skills": [{"type": "anthropic", "skill_id": "pptx", "version": "latest"}]}
    text, *uploads = params["messages"][-1]["content"]
    assert "Five slides on Q3 results" in text["text"] and "brand.pptx (the template" in text["text"]
    assert uploads == [{"type": "container_upload", "file_id": "file_up1"}, {"type": "container_upload", "file_id": "file_up2"}]
    assert ev[-1]["files"] == [{"id": "file_deck", "name": "results.pptx", "size_bytes": 2048}]  # no slide images
    assert client.get("/api/skills/files/file_deck", headers=LAB).content == b"pptx!"


def test_follow_up_continues_the_conversation_in_the_same_container(fake: Any, tmp_path: Path) -> None:
    client = make_client(fake, tmp_path)
    _, ev = turn(client, {"prompt": "A deck about tides"})
    chat_id = ev[1]["chat_id"]
    _, ev2 = turn(client, {"prompt": "Make slide 2 a chart", "chat_id": chat_id})
    assert ev2[1] == {"type": "chat", "chat_id": chat_id, "turn": 2, "model": "claude-haiku-5-5"}
    follow_up = fake.messages.calls[2]  # after the build and its review
    assert follow_up["container"]["id"] == "container_1"
    assert [m["role"] for m in follow_up["messages"]] == ["user", "assistant", "user", "assistant", "user"]
    assert follow_up["messages"][-1]["content"][0]["text"] == "Make slide 2 a chart"


@pytest.mark.parametrize("data, files, status, words", [
    ({"prompt": "   "}, [], 400, "Write a request"),
    ({"prompt": "Deck"}, [("files", ("run.exe", b"MZ", "application/octet-stream"))], 400, "attach"),
    ({"prompt": "Deck"}, [("template", ("brand.potx", b"PK", "application/octet-stream"))], 400, "must be a .pptx"),
    ({"prompt": "Deck", "chat_id": "gone"}, [], 404, "expired"),
    ({"prompt": "Deck", "model": "gpt-4"}, [], 400, "Model must be one of"),
])
def test_bad_requests_are_refused_before_anything_is_uploaded(fake: Any, tmp_path: Path, data: dict, files: list,
                                                               status: int, words: str) -> None:
    r, _ = turn(make_client(fake, tmp_path), data, files)
    assert r.status_code == status and words in r.json()["error"]["message"]
    assert fake.files.uploaded == [] and fake.messages.calls == []


def test_ending_a_conversation_deletes_its_uploads(fake: Any, tmp_path: Path) -> None:
    client = make_client(fake, tmp_path)
    _, ev = turn(client, {"prompt": "Deck"}, [("files", ("notes.md", b"# Notes", "text/markdown"))])
    assert client.delete(f"/api/decks/{ev[1]['chat_id']}", headers=LAB).json() == {"ok": True}
    assert fake.files.deleted == ["file_up1"]
    assert client.delete(f"/api/decks/{ev[1]['chat_id']}", headers=LAB).status_code == 404


def test_one_turn_at_a_time_per_conversation(fake: Any, tmp_path: Path) -> None:
    client = make_client(fake, tmp_path)
    _, ev = turn(client, {"prompt": "Deck"})
    service = client.app.state.container.decks
    chat = service.chats.get(ev[1]["chat_id"])
    chat.busy.acquire()
    with pytest.raises(ApiError) as caught:
        service.turn(chat.id, "Another change", None, [], None)
    assert caught.value.status == 409
    chat.busy.release()


def test_template_must_be_a_pptx() -> None:
    from backend.app.services.decks import check_upload
    with pytest.raises(ApiError):
        check_upload(Upload("theme.pdf", b"%PDF"), template=True)
    assert check_upload(Upload("theme.pptx", b"PK"), template=True).endswith("presentation")


def test_claude_is_shown_its_rendered_slides_in_order_and_approves_them(fake: Any, tmp_path: Path) -> None:
    _, ev = turn(make_client(fake, tmp_path), {"prompt": "Two slides on Q3"})
    review = next(e for e in ev if e["type"] == "review")
    assert review["round"] == 1 and review["deck"] == "results.pptx"
    assert [f["name"] for f in review["slides"]] == ["results-slide-01.png", "results-slide-02.png"]
    assert len(fake.messages.calls) == 2  # the build, then one check
    intro, label1, image1, label2, _ = fake.messages.calls[1]["messages"][-1]["content"]
    assert "rendered slides of results.pptx" in intro["text"] and "spacing" in intro["text"]
    assert "You will be shown the new slides" in intro["text"]
    assert (label1["text"], label2["text"]) == ("Slide 1", "Slide 2")
    assert image1["source"]["media_type"] == "image/png" and image1["source"]["type"] == "base64"
    assert ev[-2] == {"type": "says", "text": "1. Title\n2. Results"}


def test_claude_fixes_what_it_sees_and_the_new_version_is_checked_again(tmp_path: Path) -> None:
    fake = fake_client(BUILT, made("file_deck2", "file_v2s1", "file_v2s2", text="Fixed the overlap on slide 2."),
                       says("1. Title\n2. Results (fixed)"))
    _, ev = turn(make_client(fake, tmp_path), {"prompt": "Two slides on Q3"})
    reviews = [e for e in ev if e["type"] == "review"]
    assert [(r["round"], r["deck"]) for r in reviews] == [(1, "results.pptx"), (2, "results-v2.pptx")]
    assert [f["name"] for f in reviews[1]["slides"]] == ["results-v2-slide-02.png"]  # slide 1 did not change
    assert len(fake.messages.calls) == 1 + REVIEW_ROUNDS
    intro, label, _ = fake.messages.calls[2]["messages"][-1]["content"]
    assert "This is the last check" in intro["text"] and "slide 1 looks exactly as when you checked" in intro["text"]
    assert label["text"] == "Slide 2"
    assert [f["name"] for f in ev[-1]["files"]] == ["results-v2.pptx"]  # the draft is not offered
    assert ev[-2]["text"] == "1. Title\n2. Results (fixed)"


def test_slides_that_were_not_rendered_are_asked_for_once(tmp_path: Path) -> None:
    fake = fake_client(made("file_deck"), says("LibreOffice is not available here."))
    _, ev = turn(make_client(fake, tmp_path), {"prompt": "Two slides on Q3"})
    assert "Render every slide of results.pptx" in fake.messages.calls[1]["messages"][-1]["content"][0]["text"]
    assert len(fake.messages.calls) == 2
    review = next(e for e in ev if e["type"] == "review")
    assert review["slides"] == [] and "not checked by eye" in review["text"]


def test_a_reply_without_a_deck_is_not_reviewed(tmp_path: Path) -> None:
    fake = fake_client(says("Which quarter should the deck cover?"))
    _, ev = turn(make_client(fake, tmp_path), {"prompt": "A results deck"})
    assert len(fake.messages.calls) == 1 and not any(e["type"] == "review" for e in ev)


def test_a_follow_up_that_changes_no_slide_is_not_checked_again(fake: Any, tmp_path: Path) -> None:
    client = make_client(fake, tmp_path)
    _, ev = turn(client, {"prompt": "Two slides on Q3"})
    _, ev2 = turn(client, {"prompt": "Fix the speaker notes", "chat_id": ev[1]["chat_id"]})
    review = next(e for e in ev2 if e["type"] == "review")
    assert review["slides"] == [] and "nothing to check" in review["text"]
    assert len(fake.messages.calls) == 3  # build and check, then the follow-up with no second check


def test_a_deck_saved_where_the_user_cannot_get_it_is_asked_for_once(tmp_path: Path) -> None:
    fake = fake_client(says("Files are in /tmp/outputs/: results.pptx"), BUILT, LOOKS_RIGHT)
    _, ev = turn(make_client(fake, tmp_path), {"prompt": "Two slides on Q3"})
    assert "$OUTPUT_DIR" in fake.messages.calls[1]["messages"][-1]["content"][0]["text"]
    assert any(e["type"] == "review" for e in ev) and [f["name"] for f in ev[-1]["files"]] == ["results.pptx"]
    assert len(fake.messages.calls) == 3  # the build, the request to deliver it, then the check
