"""The site builder, against a scripted fake Claude stream and a fake browser: no network, no cost."""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from types import SimpleNamespace as NS
from typing import Any

import pytest
from anthropic.types import Message
from fastapi.testclient import TestClient

from backend.app.gateways.browser import Capture
from backend.app.main import create_app
from backend.app.services.sites import MAX_VERSIONS, REPORTER, REVIEW_ROUNDS, SYSTEM, cors_scripts, with_reporter
from backend.app.settings import Settings
from backend.tests.test_api import LAB

PNG = b"\x89PNG\r\n\x1a\nshot"
PAGE = "<!doctype html>\n<link rel=stylesheet href=css/site.css>\n<h1>Tide times</h1>\n"


def write(path: str, content: str, id: str = "toolu_w") -> dict:
    return {"type": "tool_use", "id": id, "name": "write_file", "input": {"path": path, "content": content}}


def call(name: str, id: str = "toolu_x", **input: Any) -> dict:
    return {"type": "tool_use", "id": id, "name": name, "input": input}


def text(t: str) -> dict:
    return {"type": "text", "text": t}


class FakeStream:
    """Replays a response as stream events: tool input arrives in small JSON pieces, as from the API."""

    def __init__(self, blocks: list[dict], stop_reason: str):
        self.final = Message.model_validate({
            "id": "msg_test", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
            "content": blocks, "stop_reason": stop_reason, "stop_sequence": None,
            "usage": {"input_tokens": 800, "output_tokens": 300}})
        self.events: list[Any] = []
        for i, block in enumerate(blocks):
            if block["type"] == "tool_use":
                self.events.append(NS(type="content_block_start", index=i, content_block=NS(
                    type="tool_use", id=block["id"], name=block["name"])))
                raw = json.dumps(block["input"])
                if stop_reason == "max_tokens" and i == len(blocks) - 1:
                    raw = raw[:len(raw) // 2]  # cut off mid-call, as when the response hits max_tokens
                self.events += [NS(type="content_block_delta", index=i, delta=NS(type="input_json_delta", partial_json=raw[j:j + 7]))
                                for j in range(0, len(raw), 7)]
            else:
                self.events.append(NS(type="content_block_start", index=i, content_block=NS(type="text")))
                self.events.append(NS(type="content_block_delta", index=i, delta=NS(type="text_delta", text=block["text"])))
            self.events.append(NS(type="content_block_stop", index=i))

    def __enter__(self) -> "FakeStream":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def __iter__(self):
        return iter(self.events)

    def get_final_message(self) -> Message:
        return self.final


class FakeMessages:
    def __init__(self, *replies: tuple[list[dict], str]):
        self.replies = list(replies)
        self.calls: list[dict] = []

    def stream(self, **params: Any) -> FakeStream:
        self.calls.append({**params, "messages": list(params["messages"])})
        blocks, stop = self.replies.pop(0) if self.replies else ([text("Looks right.")], "end_turn")
        return FakeStream(blocks, stop)


class FakeBrowser:
    available = True

    def __init__(self) -> None:
        self.urls: list[str] = []

    def capture(self, url: str, viewports: list) -> Capture:
        self.urls.append(url)
        return Capture([("desktop-1", PNG), ("phone-1", PNG)], ["Uncaught: ReferenceError: tides is not defined"])


def lab(tmp_path: Path, *replies: tuple[list[dict], str], browser: Any = None) -> tuple[TestClient, Any, Any]:
    messages = FakeMessages(*replies)
    fake = NS(messages=messages, beta=NS(messages=messages), models=NS(retrieve=lambda model: {"id": model}))
    browser = browser or FakeBrowser()
    dist = tmp_path / "dist"
    dist.mkdir(exist_ok=True)
    (dist / "index.html").write_text("<!doctype html>")
    settings = Settings(port=8000, frontend_dist=dist, models_dir=tmp_path / "none", sites_dir=tmp_path / "sites")
    client = TestClient(create_app(settings, client=fake, browser=browser), base_url="http://localhost:8000")
    return client, fake, browser


def turn(client: TestClient, prompt: str, site_id: str | None = None) -> list[dict]:
    r = client.post("/api/sites/turn", json={"prompt": prompt, **({"site_id": site_id} if site_id else {})}, headers=LAB)
    assert r.status_code == 200, r.text
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


BUILD = ([text("Building it."), write("index.html", PAGE, "toolu_1"),
          write("css/site.css", "h1{color:navy}", "toolu_2")], "tool_use")
DONE = ([text("Built a tide page.")], "end_turn")
LOOKS_RIGHT_REPLY = ([text("Looks right.")], "end_turn")  # Claude's answer to the screenshot check


def test_claude_writes_the_site_live_then_checks_screenshots(tmp_path: Path) -> None:
    client, fake, browser = lab(tmp_path, BUILD, DONE)
    ev = turn(client, "A page of tide times")
    site_id = ev[1]["site_id"]
    kinds = [e["type"] for e in ev]
    assert kinds[:3] == ["run", "site", "text"] and kinds[-1] == "files"
    # The code arrives in pieces as Claude writes it, and adds up to the file.
    deltas = [e for e in ev if e["type"] == "file_delta" and e["id"] == "toolu_1"]
    assert len(deltas) >= 1 and "".join(d["text"] for d in deltas) == PAGE and deltas[-1]["path"] == "index.html"
    assert [e["detail"] for e in ev if e["type"] == "tool"] == [f"Wrote index.html ({len(PAGE)} bytes).", "Wrote css/site.css (14 bytes)."]
    # Each file is saved as soon as Claude has written it, before its response ends, so the preview can update.
    assert kinds.index("tool") < kinds.index("file_start", kinds.index("tool")) < kinds.index("request")
    # Then the backend screenshots the site and shows Claude the pictures and the console errors.
    check = next(e for e in ev if e["type"] == "check")
    assert [s["name"] for s in check["shots"]] == ["desktop-1", "phone-1"] and check["errors"]
    assert browser.urls == [f"http://127.0.0.1:8000/sites/{site_id}/index.html"]
    review = fake.messages.calls[2]["messages"][-1]["content"]
    assert "tides is not defined" in review[0]["text"] and "You will be shown new screenshots" in review[0]["text"]
    assert [b["type"] for b in review[1:]] == ["text", "image", "text", "image"]
    first = fake.messages.calls[0]
    assert first["system"] == SYSTEM and first["cache_control"] == {"type": "ephemeral"}
    assert {t["name"] for t in first["tools"] if t.get("eager_input_streaming")} == {"write_file", "edit_file"}
    assert ev[-1]["files"] == [{"path": "css/site.css", "size": 14}, {"path": "index.html", "size": len(PAGE)}]

    # The preview serves the files sandboxed; the page can list, read, zip and see screenshots.
    page = client.get(f"/sites/{site_id}/index.html")
    assert page.text == with_reporter(PAGE) and page.headers["content-security-policy"].startswith("sandbox allow-scripts")
    assert "allow-same-origin" not in page.headers["content-security-policy"]
    assert client.get(f"/sites/{site_id}/css/site.css").headers["content-type"].startswith("text/css")
    assert client.get("/api/sites", headers=LAB).json()["sites"][0]["id"] == site_id
    detail = client.get(f"/api/sites/{site_id}", headers=LAB).json()
    assert detail["turns"][0]["prompt"] == "A page of tide times" and detail["turns"][0]["reply"] == "Looks right."
    assert client.get(f"/api/sites/{site_id}/file", params={"path": "css/site.css"}, headers=LAB).text == "h1{color:navy}"
    archive = zipfile.ZipFile(io.BytesIO(client.get(f"/api/sites/{site_id}/zip", headers=LAB).content))
    assert sorted(archive.namelist()) == ["css/site.css", "index.html"]
    assert client.get(f"/api/sites/{site_id}/shots/{check['shots'][0]['file']}", headers=LAB).content == PNG


def test_a_fix_is_checked_again_and_unchanged_files_are_not(tmp_path: Path) -> None:
    fix = ([call("edit_file", "toolu_3", path="css/site.css", old_text="navy", new_text="teal")], "tool_use")
    client, fake, browser = lab(tmp_path, BUILD, DONE, fix, ([text("Fixed the colour.")], "end_turn"))
    ev = turn(client, "A page of tide times")
    assert [e["round"] for e in ev if e["type"] == "check"] == [1, 2]
    assert "This is the last check" in fake.messages.calls[-1]["messages"][-1]["content"][0]["text"]
    assert len(fake.messages.calls) == 3 + REVIEW_ROUNDS
    assert (tmp_path / "sites" / ev[1]["site_id"] / "site" / "css" / "site.css").read_text() == "h1{color:teal}"

    # A follow-up that changes nothing is not screenshotted again.
    calls = len(fake.messages.calls)
    ev2 = turn(client, "What colour is the heading?", ev[1]["site_id"])
    assert not any(e["type"] == "check" for e in ev2) and len(fake.messages.calls) == calls + 1
    assert fake.messages.calls[-1]["messages"][-1]["content"][0]["text"] == "What colour is the heading?"


def test_the_site_and_conversation_survive_a_restart(tmp_path: Path) -> None:
    client, fake, _ = lab(tmp_path, BUILD, DONE)
    site_id = turn(client, "A page of tide times")[1]["site_id"]
    history = len(fake.messages.calls[-1]["messages"]) + 1  # plus the final reply
    again, fake2, _ = lab(tmp_path)  # a new server over the same folder
    ev = turn(again, "Add a footer", site_id)
    assert ev[1]["turn"] == 2
    assert len(fake2.messages.calls[0]["messages"]) == history + 1


@pytest.mark.parametrize("path", ["../outside.html", "/etc/x.html", ".hidden/a.html", "a\\b.html", "run.exe", ""])
def test_paths_outside_the_site_or_of_other_types_are_refused(tmp_path: Path, path: str) -> None:
    client, fake, _ = lab(tmp_path, ([write(path, "x")], "tool_use"), DONE)
    ev = turn(client, "Make a page")
    result = next(e for e in ev if e["type"] == "tool")
    assert result["ok"] is False
    sent = fake.messages.calls[1]["messages"][-1]["content"][0]
    assert sent["is_error"] is True and sent["tool_use_id"] == "toolu_w"
    assert not (tmp_path / "outside.html").exists() and not any(e["type"] == "check" for e in ev)


def test_an_edit_needs_text_that_appears_exactly_once(tmp_path: Path) -> None:
    edit = ([call("edit_file", "toolu_e", path="index.html", old_text="Moon", new_text="Sun")], "tool_use")
    client, fake, _ = lab(tmp_path, BUILD, edit, DONE)
    turn(client, "A page")
    sent = fake.messages.calls[2]["messages"][-1]["content"][0]
    assert sent["is_error"] and "appears 0 times" in sent["content"]


def test_a_call_cut_off_by_max_tokens_is_not_run(tmp_path: Path) -> None:
    client, fake, _ = lab(tmp_path, ([write("index.html", PAGE)], "max_tokens"), DONE)
    ev = turn(client, "A page")
    sent = fake.messages.calls[1]["messages"][-1]["content"][0]
    assert sent["is_error"] and "cut off" in sent["content"]
    assert ev[-1]["files"] == []


def test_without_a_browser_the_check_is_skipped_and_says_why(tmp_path: Path) -> None:
    client, fake, _ = lab(tmp_path, BUILD, DONE, browser=NS(available=False))
    ev = turn(client, "A page")
    check = next(e for e in ev if e["type"] == "check")
    assert check["shots"] == [] and "LLM_LAB_CHROME" in check["text"] and len(fake.messages.calls) == 2


@pytest.mark.parametrize("body, status", [
    ({"prompt": ""}, 400), ({"prompt": "x", "site_id": "nope"}, 400), ({"prompt": "x", "site_id": "0123456789ab"}, 404),
    ({"prompt": "x", "model": "gpt-4"}, 400),
])
def test_bad_requests_are_refused(tmp_path: Path, body: dict, status: int) -> None:
    client, fake, _ = lab(tmp_path)
    assert client.post("/api/sites/turn", json=body, headers=LAB).status_code == status
    assert fake.messages.calls == []


def test_site_files_need_the_right_host_and_a_known_site(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    assert client.get(f"/sites/{site_id}/index.html", headers={"host": "evil.example"}).status_code == 404
    assert client.get("/sites/0123456789ab/index.html").status_code == 404
    assert client.get(f"/sites/{site_id}/../chat.json").status_code == 404
    assert client.delete(f"/api/sites/{site_id}", headers=LAB).json() == {"ok": True}
    assert client.get(f"/sites/{site_id}/index.html").status_code == 404


def test_sonnet_turns_go_through_the_refusal_fallback(tmp_path: Path) -> None:
    client, fake, _ = lab(tmp_path, DONE)
    r = client.post("/api/sites/turn", json={"prompt": "A page", "model": "claude-sonnet-5-5"}, headers=LAB)
    assert r.status_code == 200
    assert fake.messages.calls[0]["fallbacks"] == "default" and fake.messages.calls[0]["model"] == "claude-sonnet-5-5"


def test_a_site_can_be_restored_to_before_any_message(tmp_path: Path) -> None:
    replace = ([call("delete_file", "toolu_d", path="index.html"), write("match.html", "<h1>Football</h1>", "toolu_m")], "tool_use")
    client, fake, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, replace, DONE, LOOKS_RIGHT_REPLY)
    site_id = turn(client, "A bakery page")[1]["site_id"]
    turn(client, "Make it a football site", site_id)
    folder = tmp_path / "sites" / site_id
    assert sorted(f["path"] for f in client.get(f"/api/sites/{site_id}", headers=LAB).json()["files"]) == ["css/site.css", "match.html"]

    r = client.post(f"/api/sites/{site_id}/restore", json={"keep": 1}, headers=LAB)
    assert r.status_code == 200, r.text
    assert [t["prompt"] for t in r.json()["turns"]] == ["A bakery page"]
    assert sorted(f["path"] for f in r.json()["files"]) == ["css/site.css", "index.html"]
    assert (folder / "site" / "index.html").read_text() == PAGE
    backups = list((folder / "backups").glob("*/site/match.html"))
    assert len(backups) == 1  # the replaced files are kept, not deleted
    # The conversation continues from the bakery: the football messages are gone.
    calls = len(fake.messages.calls)
    turn(client, "Add opening hours", site_id)
    sent = fake.messages.calls[calls]["messages"]
    assert not any("football" in json.dumps(m["content"]).lower() for m in sent)
    assert sent[-1]["content"][0]["text"] == "Add opening hours"


def test_restore_finds_messages_in_sites_saved_before_it_existed(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, ([write("index.html", "<h1>Other</h1>", "toolu_o")], "tool_use"), DONE)
    site_id = turn(client, "A bakery page")[1]["site_id"]
    turn(client, "Change everything", site_id)
    saved = tmp_path / "sites" / site_id / "chat.json"
    data = json.loads(saved.read_text())
    for t in data["turns"]:
        t.pop("start")  # as sites saved by the earlier version
    saved.write_text(json.dumps(data))
    again, _, _ = lab(tmp_path)  # a restarted server reads it from disk
    assert again.post(f"/api/sites/{site_id}/restore", json={"keep": 1}, headers=LAB).status_code == 200
    assert (tmp_path / "sites" / site_id / "site" / "index.html").read_text() == PAGE


def test_restore_refuses_a_message_that_does_not_exist(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE)
    site_id = turn(client, "A bakery page")[1]["site_id"]
    assert client.post(f"/api/sites/{site_id}/restore", json={"keep": 5}, headers=LAB).status_code == 400
    assert client.post("/api/sites/0123456789ab/restore", json={"keep": 0}, headers=LAB).status_code == 404


# ----- Versions, rename, delete while busy, the error reporter -----

EDIT = ([call("edit_file", "toolu_e", path="css/site.css", old_text="navy", new_text="teal")], "tool_use")
READ_ONLY = ([call("read_file", "toolu_r", path="index.html")], "tool_use")


def test_each_turn_that_changes_files_is_a_version_with_what_changed(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, EDIT, DONE, LOOKS_RIGHT_REPLY, READ_ONLY, DONE)
    events = turn(client, "A page of tide times")
    site_id = events[1]["site_id"]
    assert [e["version"]["n"] for e in events if e["type"] == "version"] == [1]
    assert all("fingerprint" not in e["version"] for e in events if e["type"] == "version")
    assert events[-1]["changed"] == [{"path": "css/site.css", "change": "added"}, {"path": "index.html", "change": "added"}]
    assert turn(client, "Make the heading teal", site_id)[-1]["changed"] == [{"path": "css/site.css", "change": "changed"}]
    last = turn(client, "What is on the page?", site_id)[-1]
    assert last["changed"] == [] and last["version"] is None  # nothing changed: no new version
    detail = client.get(f"/api/sites/{site_id}", headers=LAB).json()
    assert [v["n"] for v in detail["versions"]] == [1, 2]
    assert [t["version"] for t in detail["turns"]] == [1, 2, None]
    assert "fingerprint" not in detail["versions"][0]


def test_an_old_version_is_served_as_it_was_sandboxed_with_the_reporter(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, EDIT, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    turn(client, "Teal", site_id)
    old = client.get(f"/site-versions/{site_id}/1/css/site.css")
    assert old.status_code == 200 and old.text == "h1{color:navy}"
    assert old.headers["content-security-policy"].startswith("sandbox allow-scripts")
    assert client.get(f"/sites/{site_id}/css/site.css").text == "h1{color:teal}"
    page = client.get(f"/site-versions/{site_id}/1/index.html")
    assert REPORTER in page.text and page.headers["content-security-policy"].startswith("sandbox")
    assert client.get(f"/site-versions/{site_id}/99/index.html").status_code == 404
    assert client.get(f"/site-versions/{site_id}/1/../../chat.json").status_code == 404
    assert client.get(f"/site-versions/{site_id}/1/index.html", headers={"host": "evil.example"}).status_code == 404


def test_restoring_a_version_is_itself_a_version_and_claude_is_told(tmp_path: Path) -> None:
    client, fake, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, EDIT, DONE, LOOKS_RIGHT_REPLY, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    turn(client, "Teal", site_id)
    r = client.post(f"/api/sites/{site_id}/versions/1/restore", headers=LAB)
    assert r.status_code == 200, r.text
    detail = r.json()
    assert [v["n"] for v in detail["versions"]] == [1, 2, 3] and detail["versions"][-1]["label"] == "Restored version 1"
    assert detail["turns"][-1]["kind"] == "restore" and detail["turns"][-1]["version"] == 3
    assert (tmp_path / "sites" / site_id / "site" / "css" / "site.css").read_text() == "h1{color:navy}"
    # Restoring the current version again changes nothing and is refused; an unknown version is not found.
    assert client.post(f"/api/sites/{site_id}/versions/3/restore", headers=LAB).status_code == 400
    assert client.post(f"/api/sites/{site_id}/versions/42/restore", headers=LAB).status_code == 404
    calls = len(fake.messages.calls)
    turn(client, "Add a footer", site_id)
    sent = fake.messages.calls[calls]["messages"][-1]["content"]
    assert "restored version 1" in sent[0]["text"] and sent[-1]["text"] == "Add a footer"
    # The notice is sent once, not with every later message.
    again = client.get(f"/api/sites/{site_id}", headers=LAB).json()
    assert len(again["turns"]) == 4


def test_only_the_newest_versions_are_kept(tmp_path: Path) -> None:
    edits = []
    for i in range(MAX_VERSIONS + 3):
        # No browser, so there is no screenshot check and each turn is exactly a write and a reply.
        edits += [([write("index.html", f"<h1>Page {i}</h1>", f"toolu_{i}")], "tool_use"), ([text(f"v{i}")], "end_turn")]
    client, _, _ = lab(tmp_path, *edits, browser=NS(available=False))
    site_id = turn(client, "A page")[1]["site_id"]
    for i in range(1, MAX_VERSIONS + 3):
        turn(client, f"Change {i}", site_id)
    versions = client.get(f"/api/sites/{site_id}", headers=LAB).json()["versions"]
    assert len(versions) == MAX_VERSIONS and versions[0]["n"] == 4 and versions[-1]["n"] == MAX_VERSIONS + 3
    kept = sorted(int(p.name) for p in (tmp_path / "sites" / site_id / "versions").iterdir())
    assert kept == [v["n"] for v in versions]


def test_versions_and_titles_survive_a_restart(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    assert client.patch(f"/api/sites/{site_id}", json={"title": "  Tide   times  "}, headers=LAB).json()["title"] == "Tide times"
    again, _, _ = lab(tmp_path)
    detail = again.get(f"/api/sites/{site_id}", headers=LAB).json()
    assert detail["title"] == "Tide times" and [v["n"] for v in detail["versions"]] == [1]
    listed = again.get("/api/sites", headers=LAB).json()["sites"][0]
    assert listed["title"] == "Tide times" and listed["versions"] == 1 and listed["thumb"].endswith("-desktop-1.png")


def test_a_bad_title_is_refused(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    assert client.patch(f"/api/sites/{site_id}", json={"title": "   "}, headers=LAB).status_code == 400
    assert client.patch(f"/api/sites/{site_id}", json={"title": "x" * 300}, headers=LAB).status_code == 400
    assert client.patch("/api/sites/0123456789ab", json={"title": "x"}, headers=LAB).status_code == 404


def test_a_site_made_before_versions_gets_its_current_files_as_version_one(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    saved = tmp_path / "sites" / site_id / "chat.json"
    data = json.loads(saved.read_text())
    for key in ("versions", "next_version", "notice"):
        data.pop(key)
    saved.write_text(json.dumps(data))
    import shutil
    shutil.rmtree(tmp_path / "sites" / site_id / "versions")
    again, _, _ = lab(tmp_path)
    versions = again.get(f"/api/sites/{site_id}", headers=LAB).json()["versions"]
    assert [(v["n"], v["label"]) for v in versions] == [(1, "Before versions were kept")]


def test_a_busy_site_cannot_be_deleted_or_restored(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, EDIT, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    turn(client, "Teal", site_id)
    site = client.app.state.container.sites.store.get(site_id)
    assert site.busy.acquire(blocking=False)  # as while a turn is running
    try:
        assert client.delete(f"/api/sites/{site_id}", headers=LAB).status_code == 409
        assert client.post(f"/api/sites/{site_id}/versions/1/restore", headers=LAB).status_code == 409
        assert client.post("/api/sites/turn", json={"prompt": "More", "site_id": site_id}, headers=LAB).status_code == 409
        assert client.get("/api/sites", headers=LAB).json()["sites"][0]["running"] is True
    finally:
        site.busy.release()
    assert (tmp_path / "sites" / site_id / "site" / "index.html").is_file()
    assert client.delete(f"/api/sites/{site_id}", headers=LAB).status_code == 200


@pytest.mark.parametrize("html,first", [
    ("<!doctype html><html><head><title>x</title></head><body></body></html>", "<!doctype html><html><head>"),
    ("<!DOCTYPE html>\n<h1>No head</h1>", "<!DOCTYPE html>"),
    ("<h1>Bare</h1>", ""),
    ("<!doctype html><header>Not a head</header>", "<!doctype html>"),
])
def test_the_reporter_goes_first_in_the_head_and_never_before_the_doctype(html: str, first: str) -> None:
    out = with_reporter(html)
    assert out.startswith(first + REPORTER) and out.replace(REPORTER, "", 1) == html
    assert "addEventListener('message'" not in REPORTER and "postMessage" in REPORTER  # it sends, it never listens


def test_the_sites_own_scripts_load_with_cors_so_their_errors_can_be_read() -> None:
    html = ('<script src="js/app.js"></script><script type="module" src=\'js/m.js\'></script>'
            '<script src="https://cdn.example/lib.js"></script><script src="//cdn.example/x.js"></script>'
            '<script src="js/a.js" crossorigin="anonymous"></script><script>inline()</script>')
    out = cors_scripts(html)
    assert '<script src="js/app.js" crossorigin>' in out and "<script type=\"module\" src='js/m.js' crossorigin>" in out
    assert '<script src="https://cdn.example/lib.js">' in out and '<script src="//cdn.example/x.js">' in out
    assert out.count("crossorigin") == 3 and "<script>inline()</script>" in out


# ----- Review findings -----

def test_finding_1_a_failed_restore_copy_leaves_the_live_site_untouched(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from backend.app.services import sites as sites_module

    client, _, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, EDIT, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    turn(client, "Teal", site_id)
    live = tmp_path / "sites" / site_id / "site"
    real = sites_module.shutil.copytree

    def failing(src: Any, dst: Any, *a: Any, **k: Any) -> Any:
        if ".restore-" in str(dst):
            raise OSError("disk full")
        return real(src, dst, *a, **k)

    monkeypatch.setattr(sites_module.shutil, "copytree", failing)
    r = client.post(f"/api/sites/{site_id}/versions/1/restore", headers=LAB)
    assert r.status_code == 500 and "unchanged" in r.json()["error"]["message"]
    assert (live / "css" / "site.css").read_text() == "h1{color:teal}" and (live / "index.html").is_file()
    assert not list((tmp_path / "sites" / site_id).glob(".restore-*"))
    assert not list((tmp_path / "sites" / site_id).glob(".replaced-*"))
    monkeypatch.setattr(sites_module.shutil, "copytree", real)
    assert client.post(f"/api/sites/{site_id}/versions/1/restore", headers=LAB).status_code == 200  # the lock was released


def test_finding_1_the_current_files_are_kept_as_a_version_before_a_restore(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, EDIT, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    turn(client, "Teal", site_id)
    # The site is changed outside a turn (as after a stop part-way through), so the current files are in no version.
    (tmp_path / "sites" / site_id / "site" / "extra.html").write_text("<p>unsaved</p>")
    versions = client.post(f"/api/sites/{site_id}/versions/1/restore", headers=LAB).json()["versions"]
    assert [v["label"] for v in versions][-2:] == ["Before restoring version 1", "Restored version 1"]
    kept = tmp_path / "sites" / site_id / "versions" / str(versions[-2]["n"]) / "extra.html"
    assert kept.read_text() == "<p>unsaved</p>"


def test_finding_2_a_failing_snapshot_still_saves_the_turn_and_sends_the_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from backend.app.services.sites import SiteService

    def broken(self: Any, site: Any, label: str) -> None:
        raise OSError("no space left on device")

    client, _, _ = lab(tmp_path, BUILD, DONE)
    monkeypatch.setattr(SiteService, "_snapshot", broken)
    events = turn(client, "A page")
    site_id = events[1]["site_id"]
    last = events[-1]
    assert last["type"] == "files" and sorted(f["path"] for f in last["files"]) == ["css/site.css", "index.html"]
    assert last["version"] is None and "not kept as a version" in last["snapshot_error"]
    assert not any(e["type"] == "error" for e in events)  # the turn's own outcome is not replaced
    stored = client.get(f"/api/sites/{site_id}", headers=LAB).json()["turns"][0]
    # The turn kept its reply (the answer to the screenshot check is the last one) alongside the failure.
    assert stored["reply"] == "Looks right." and "no space left" in stored["snapshot_error"]


def test_finding_3_reading_an_old_site_never_takes_its_lock(tmp_path: Path) -> None:
    import shutil
    from concurrent.futures import ThreadPoolExecutor

    client, _, _ = lab(tmp_path, BUILD, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    saved = tmp_path / "sites" / site_id / "chat.json"
    data = json.loads(saved.read_text())
    for key in ("versions", "next_version", "thumb"):
        data.pop(key, None)
    saved.write_text(json.dumps(data))
    shutil.rmtree(tmp_path / "sites" / site_id / "versions")
    again, _, _ = lab(tmp_path)
    with ThreadPoolExecutor(8) as pool:
        replies = list(pool.map(lambda _: again.get(f"/api/sites/{site_id}", headers=LAB).json(), range(8)))
    assert all(r["running"] is False for r in replies)
    assert all([v["n"] for v in r["versions"]] == [1] for r in replies)  # the one-off version is taken once
    assert sorted(p.name for p in (tmp_path / "sites" / site_id / "versions").iterdir()) == ["1"]


def test_finding_4_a_restore_to_before_a_message_clears_a_pending_version_notice(tmp_path: Path) -> None:
    client, fake, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, EDIT, DONE, LOOKS_RIGHT_REPLY, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    turn(client, "Teal", site_id)
    assert client.post(f"/api/sites/{site_id}/versions/1/restore", headers=LAB).status_code == 200
    assert client.post(f"/api/sites/{site_id}/restore", json={"keep": 1}, headers=LAB).status_code == 200
    calls = len(fake.messages.calls)
    turn(client, "Add a footer", site_id)
    sent = fake.messages.calls[calls]["messages"][-1]["content"]
    assert [b["text"] for b in sent] == ["Add a footer"]


def test_finding_5_the_list_of_sites_uses_the_remembered_screenshot(tmp_path: Path) -> None:
    import shutil

    client, _, _ = lab(tmp_path, BUILD, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    thumb = client.get("/api/sites", headers=LAB).json()["sites"][0]["thumb"]
    assert thumb and thumb.endswith("-desktop-1.png")
    assert json.loads((tmp_path / "sites" / site_id / "chat.json").read_text())["thumb"] == thumb
    shutil.rmtree(tmp_path / "sites" / site_id / "shots")  # the list must not scan the folder again
    assert client.get("/api/sites", headers=LAB).json()["sites"][0]["thumb"] == thumb
