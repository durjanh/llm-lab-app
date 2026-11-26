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


def test_finding_6_restore_to_before_a_message_uses_the_files_the_person_saw(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, EDIT, DONE)
    site_id = turn(client, "A page")[1]["site_id"]            # message 0 -> version 1 (navy)
    turn(client, "Teal", site_id)                              # message 1 -> version 2 (teal)
    assert client.post(f"/api/sites/{site_id}/versions/1/restore", headers=LAB).status_code == 200  # a note, not a message
    site_dir = tmp_path / "sites" / site_id
    r = client.post(f"/api/sites/{site_id}/restore", json={"keep": 1}, headers=LAB)  # back to before "Teal"
    assert r.status_code == 200, r.text
    assert (site_dir / "site" / "css" / "site.css").read_text() == "h1{color:navy}"  # as after message 0
    assert (site_dir / "site" / "index.html").read_text() == PAGE
    assert [t["prompt"] for t in r.json()["turns"]] == ["A page"]
    # The note about the restored version is not a message: there are only two messages to choose from.
    (tmp_path / "b").mkdir()
    client2, _, _ = lab(tmp_path / "b", BUILD, DONE, LOOKS_RIGHT_REPLY, EDIT, DONE)
    other = turn(client2, "A page")[1]["site_id"]
    turn(client2, "Teal", other)
    client2.post(f"/api/sites/{other}/versions/1/restore", headers=LAB)
    assert client2.post(f"/api/sites/{other}/restore", json={"keep": 2}, headers=LAB).status_code == 400


def test_finding_6_restore_to_before_the_first_message_empties_the_site(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    r = client.post(f"/api/sites/{site_id}/restore", json={"keep": 0}, headers=LAB)
    assert r.status_code == 200 and r.json()["files"] == [] and r.json()["turns"] == []
    assert list((tmp_path / "sites" / site_id / "backups").glob("*/site/index.html"))  # the files were kept aside


def test_finding_6_a_site_from_before_versions_is_rebuilt_by_replay_unless_a_version_was_restored(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, EDIT, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    turn(client, "Teal", site_id)
    saved = tmp_path / "sites" / site_id / "chat.json"
    data = json.loads(saved.read_text())
    for t in data["turns"]:
        t.pop("version")  # as turns saved before versions existed
    saved.write_text(json.dumps(data))
    again, _, _ = lab(tmp_path)
    assert again.post(f"/api/sites/{site_id}/restore", json={"keep": 1}, headers=LAB).status_code == 200
    assert (tmp_path / "sites" / site_id / "site" / "css" / "site.css").read_text() == "h1{color:navy}"
    # With a version restored after such turns, replaying would give the wrong files, so it is refused.
    data = json.loads(saved.read_text())
    data["turns"].append({"kind": "restore", "prompt": "", "reply": "Restored version 1.", "model": "", "time": 1,
                          "start": len(data["history"]), "changed": [], "version": None, "cost": 0})
    data["turns"].append({"prompt": "More", "reply": "ok", "model": "m", "time": 2, "start": len(data["history"])})
    saved.write_text(json.dumps(data))
    third, _, _ = lab(tmp_path)
    assert third.post(f"/api/sites/{site_id}/restore", json={"keep": 1}, headers=LAB).status_code == 409


def test_finding_6_a_version_no_longer_kept_is_refused_clearly(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE, LOOKS_RIGHT_REPLY, EDIT, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    turn(client, "Teal", site_id)
    site = client.app.state.container.sites.store.get(site_id)
    site.versions = [v for v in site.versions if v["n"] != 1]  # as if version 1 had been dropped by the limit
    r = client.post(f"/api/sites/{site_id}/restore", json={"keep": 1}, headers=LAB)
    assert r.status_code == 409 and "no longer kept" in r.json()["error"]["message"]
    assert (tmp_path / "sites" / site_id / "site" / "css" / "site.css").read_text() == "h1{color:teal}"


# ----- Attachments and effort -----

def png(width: int = 40, height: int = 30, colour: tuple = (20, 120, 200)) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(out, "PNG")
    return out.getvalue()


def upload(client: TestClient, *files: tuple[str, bytes, str]) -> Any:
    return client.post("/api/sites/uploads", headers=LAB, files=[("files", f) for f in files])


def test_uploads_are_checked_by_content_and_name(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path)
    ok = upload(client, ("../../shot.png", png(), "image/png"), ("data.csv", b"day,high\nMon,4.2\n", "text/csv"))
    assert ok.status_code == 200, ok.text
    assert [(u["name"], u["kind"]) for u in ok.json()] == [("shot.png", "image"), ("data.csv", "data")]
    assert all(len(u["id"]) == 32 for u in ok.json())
    bad = [
        (("run.exe", b"MZ", "application/octet-stream"), "attach pictures"),
        (("fake.png", b"not a picture", "image/png"), "not a picture"),
        (("empty.csv", b"", "text/csv"), "empty"),
        (("latin.csv", "café".encode("latin-1"), "text/csv"), "UTF-8"),
        (("brief.pdf", b"hello", "application/pdf"), "not a PDF"),
        (("big.json", b"[" + b"1," * 160_000 + b"1]", "application/json"), "limit"),
    ]
    for file, why in bad:
        r = upload(client, file)
        assert r.status_code == 400 and why in r.json()["error"]["message"], (file[0], r.text)
    many = upload(client, *[(f"{i}.txt", b"x", "text/plain") for i in range(7)])
    assert many.status_code == 400


def test_a_large_picture_is_shrunk_and_a_gif_becomes_a_png(tmp_path: Path) -> None:
    from PIL import Image

    client, _, _ = lab(tmp_path)
    gif = io.BytesIO()
    Image.new("RGB", (10, 10), (255, 0, 0)).save(gif, "GIF")
    r = upload(client, ("wide.png", png(3000, 1000), "image/png"), ("anim.gif", gif.getvalue(), "image/gif"))
    assert r.status_code == 200, r.text
    wide, anim = r.json()
    stored = client.app.state.container.sites.uploads.get(wide["id"])
    assert max(Image.open(stored.path).size) == 1568
    assert anim["media_type"] == "image/png"


def test_unused_uploads_expire_after_a_day(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path)
    uploads = client.app.state.container.sites.uploads
    up = upload(client, ("a.txt", b"hello", "text/plain")).json()[0]
    meta = uploads.root / up["id"] / "meta.json"
    data = json.loads(meta.read_text())
    data["created"] -= 25 * 3600
    meta.write_text(json.dumps(data))
    assert uploads.prune() == 1 and uploads.get(up["id"]) is None
    assert not (uploads.root / up["id"]).exists()


def test_a_picture_reaches_the_model_and_is_kept_on_the_turn(tmp_path: Path) -> None:
    client, fake, _ = lab(tmp_path, BUILD, DONE)
    up = upload(client, ("mock.png", png(), "image/png")).json()[0]
    r = client.post("/api/sites/turn", json={"prompt": "Build something like this", "attachments": [up["id"]]}, headers=LAB)
    assert r.status_code == 200, r.text
    site_id = json.loads(r.text.splitlines()[1])["site_id"]
    sent = fake.messages.calls[0]["messages"][-1]["content"]
    kinds = [b["type"] for b in sent]
    assert "image" in kinds and sent[-1]["text"] == "Build something like this"
    image = next(b for b in sent if b["type"] == "image")
    assert image["source"]["media_type"] == "image/png" and image["source"]["data"]
    assert any("your own original code" in b.get("text", "") for b in sent)
    assert client.app.state.container.sites.uploads.get(up["id"]) is None  # used up
    again, _, _ = lab(tmp_path)  # after a restart, the page still shows what was attached
    turn0 = again.get(f"/api/sites/{site_id}", headers=LAB).json()["turns"][0]
    assert turn0["attachments"] == [{"name": "mock.png", "media_type": "image/png", "kind": "image"}]


def test_a_data_file_is_copied_into_the_site_and_listed(tmp_path: Path) -> None:
    client, fake, _ = lab(tmp_path, DONE)
    up = upload(client, ("tides.csv", b"day,high\nMon,4.2\n", "text/csv")).json()[0]
    events = turn_with(client, "Chart these tides", attachments=[up["id"]])
    site_id = events[1]["site_id"]
    assert (tmp_path / "sites" / site_id / "site" / "assets" / "tides.csv").read_text() == "day,high\nMon,4.2\n"
    sent = fake.messages.calls[0]["messages"][-1]["content"]
    assert any("assets/tides.csv" in b.get("text", "") for b in sent)
    assert {"path": "assets/tides.csv", "change": "added"} in events[-1]["changed"]


def turn_with(client: TestClient, prompt: str, site_id: str | None = None, **extra: Any) -> list[dict]:
    r = client.post("/api/sites/turn", json={"prompt": prompt, **({"site_id": site_id} if site_id else {}), **extra}, headers=LAB)
    assert r.status_code == 200, r.text
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


def test_a_pdf_goes_to_claude_as_a_document_and_is_refused_for_other_models(tmp_path: Path) -> None:
    client, fake, _ = lab(tmp_path, DONE)
    up = upload(client, ("brief.pdf", b"%PDF-1.4\n% test\n", "application/pdf")).json()[0]
    service = client.app.state.container.sites
    with pytest.raises(Exception) as refused:
        service._attachments([up["id"]], "gpt-5.4-mini")
    assert getattr(refused.value, "status", None) == 400 and "only Claude" in str(refused.value)
    turn_with(client, "Use the brief", attachments=[up["id"]])
    sent = fake.messages.calls[0]["messages"][-1]["content"]
    assert any(b["type"] == "document" and b["source"]["media_type"] == "application/pdf" for b in sent)


def test_unknown_repeated_or_too_many_attachments_are_refused_before_a_site_is_made(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path)
    r = client.post("/api/sites/turn", json={"prompt": "A page", "attachments": ["0" * 32]}, headers=LAB)
    assert r.status_code == 400 and "unknown or has expired" in r.json()["error"]["message"]
    up = upload(client, ("a.txt", b"hi", "text/plain")).json()[0]
    assert client.post("/api/sites/turn", json={"prompt": "A", "attachments": [up["id"], up["id"]]}, headers=LAB).status_code == 400
    assert client.post("/api/sites/turn", json={"prompt": "A", "attachments": ["../../etc/passwd"]}, headers=LAB).status_code == 400
    assert client.post("/api/sites/turn", json={"prompt": "A", "attachments": ["a" * 32] * 7}, headers=LAB).status_code == 400
    assert client.get("/api/sites", headers=LAB).json()["sites"] == []  # no empty site was left behind


def test_effort_reaches_the_model_and_is_saved_with_the_site(tmp_path: Path) -> None:
    client, fake, _ = lab(tmp_path, DONE, DONE)
    site_id = turn_with(client, "A page", effort="high")[1]["site_id"]
    assert fake.messages.calls[0]["output_config"] == {"effort": "high"}
    turn_with(client, "More", site_id)  # no effort given: medium, which Claude takes
    assert fake.messages.calls[-1]["output_config"] == {"effort": "medium"}
    again, _, _ = lab(tmp_path)
    assert again.get(f"/api/sites/{site_id}", headers=LAB).json()["settings"]["effort"] == "medium"
    assert again.post("/api/sites/turn", json={"prompt": "A", "effort": "turbo"}, headers=LAB).status_code == 400


def test_effort_is_checked_per_model_and_the_local_model_takes_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from backend.app.services import sites as sites_module

    client, _, _ = lab(tmp_path)
    service = client.app.state.container.sites
    listed = client.get("/api/sites", headers=LAB).json()["models"]
    assert listed["claude-haiku-5-5"] == {"images": True, "pdf": True, "efforts": ["low", "medium", "high", "xhigh", "max"]}
    with pytest.raises(Exception) as refused:
        service._effort("gpt-5.4-mini", "max")  # GPT takes low, medium and high
    assert getattr(refused.value, "status", None) == 400
    assert service._effort("gpt-5.4-mini", None) == "medium"
    monkeypatch.setattr(sites_module, "efforts_for", lambda m: [] if m == "local-test" else ["low", "medium", "high"])
    assert service._effort("local-test", None) == ""
    with pytest.raises(Exception):
        service._effort("local-test", "low")
    assert service.capabilities("local-test")["images"] is None  # unknown until it has been tried


def test_a_model_that_cannot_read_pictures_is_remembered_and_refused(tmp_path: Path) -> None:
    from backend.app.shared import NoVision

    client, fake, _ = lab(tmp_path)
    fake.messages.stream = lambda **params: (_ for _ in ()).throw(NoVision("The local model cannot read images."))
    up = upload(client, ("mock.png", png(), "image/png")).json()[0]
    events = turn_with(client, "Like this", attachments=[up["id"]])
    assert any(e["type"] == "error" and "cannot read images" in e["message"] for e in events)
    service = client.app.state.container.sites
    assert service.capabilities("claude-haiku-5-5")["images"] is False
    second = upload(client, ("mock.png", png(), "image/png")).json()[0]
    r = client.post("/api/sites/turn", json={"prompt": "Again", "attachments": [second["id"]]}, headers=LAB)
    assert r.status_code == 400 and "cannot read pictures" in r.json()["error"]["message"]


# ----- Review findings: uploads, rename and the reporter -----

def huge_png_header(width: int, height: int) -> bytes:
    """A PNG that is only a header: it declares a huge picture but holds no pixels, as a decompression bomb would."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


def test_review_1_a_picture_declaring_huge_dimensions_is_refused_cleanly(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path)
    r = upload(client, ("bomb.png", huge_png_header(100_000, 100_000), "image/png"))
    assert r.status_code == 400, r.text
    message = r.json()["error"]["message"]
    assert "bomb.png" in message and "too large" in message
    # Just over the page's own cap (40 million pixels), still well under Pillow's own limit: refused from the header.
    r = upload(client, ("wide.png", huge_png_header(8_000, 5_001), "image/png"))
    assert r.status_code == 400 and "million pixels" in r.json()["error"]["message"]
    assert upload(client, ("ok.png", png(), "image/png")).status_code == 200


def test_review_2_a_site_cannot_be_renamed_while_claude_is_working_on_it(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path, BUILD, DONE)
    site_id = turn(client, "A page")[1]["site_id"]
    site = client.app.state.container.sites.store.get(site_id)
    assert site.busy.acquire(blocking=False)  # as while a turn is running
    try:
        r = client.patch(f"/api/sites/{site_id}", json={"title": "New name"}, headers=LAB)
        assert r.status_code == 409 and r.json()["error"]["type"] == "busy"
    finally:
        site.busy.release()
    assert site.title != "New name"
    assert client.patch(f"/api/sites/{site_id}", json={"title": "New name"}, headers=LAB).json()["title"] == "New name"


def test_review_3_waiting_uploads_have_a_total_cap_after_expired_ones_go(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path)
    uploads = client.app.state.container.sites.uploads
    uploads.max_waiting_files = 2
    first = upload(client, ("a.txt", b"one", "text/plain")).json()[0]
    assert upload(client, ("b.txt", b"two", "text/plain")).status_code == 200
    over = upload(client, ("c.txt", b"three", "text/plain"))
    assert over.status_code == 413 and "waiting" in over.json()["error"]["message"]
    meta = uploads.root / first["id"] / "meta.json"
    data = json.loads(meta.read_text())
    data["created"] -= 25 * 3600  # the first one expires, so there is room again
    meta.write_text(json.dumps(data))
    assert upload(client, ("c.txt", b"three", "text/plain")).status_code == 200
    uploads.max_waiting_files, uploads.max_waiting_bytes = 100, 10
    assert upload(client, ("d.txt", b"more than ten bytes", "text/plain")).status_code == 413


def test_review_4_comments_and_script_bodies_are_not_mistaken_for_markup() -> None:
    page = ('<!-- old <head> -->\n<!doctype html><html><head><title>x</title>'
            '<!-- <script src="js/old.js"></script> -->'
            '<script>var tag = \'<script src="js/fake.js">\';</script>'
            '<script src="js/app.js"></script></head><body></body></html>')
    out = with_reporter(page)
    assert out.index(REPORTER) == out.index("<html><head>") + len("<html><head>")  # after the real head
    assert '<!-- old <head> -->' in out and out.count(REPORTER) == 1
    assert '<!-- <script src="js/old.js"></script> -->' in out  # a script in a comment is left alone
    assert '\'<script src="js/fake.js">\'' in out  # and so is one inside a script's own text
    assert '<script src="js/app.js" crossorigin>' in out


def test_review_5_two_pictures_checked_at_once_in_threads_both_behave(tmp_path: Path) -> None:
    import warnings
    from concurrent.futures import ThreadPoolExecutor

    client, _, _ = lab(tmp_path)
    before = list(warnings.filters)
    jobs = [("bomb.png", huge_png_header(100_000, 100_000)), ("ok.png", png()), ("wide.png", huge_png_header(8_000, 5_001)),
            ("ok2.png", png(60, 40))]
    with ThreadPoolExecutor(4) as pool:
        replies = list(pool.map(lambda job: upload(client, (job[0], job[1], "image/png")), jobs * 3))
    for (name, _), r in zip(jobs * 3, replies):
        assert r.status_code == (200 if name.startswith("ok") else 400), (name, r.text)
    assert list(warnings.filters) == before  # no process-wide warning filter was changed


def test_review_6_expired_uploads_never_count_towards_the_cap(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path)
    uploads = client.app.state.container.sites.uploads
    first = upload(client, ("a.txt", b"one", "text/plain")).json()[0]
    meta = uploads.root / first["id"] / "meta.json"
    data = json.loads(meta.read_text())
    data["created"] -= 25 * 3600
    meta.write_text(json.dumps(data))
    assert uploads.waiting() == (0, 0)  # expired but not yet pruned: not counted
    assert (uploads.root / first["id"]).exists()


def test_review_6_one_caller_at_its_cap_does_not_stop_another(tmp_path: Path) -> None:
    client, _, _ = lab(tmp_path)
    uploads = client.app.state.container.sites.uploads
    uploads.max_caller_files = 2

    def send(caller: str, name: str) -> Any:
        return client.post("/api/sites/uploads", headers=LAB, data={"caller": caller},
                           files=[("files", (name, b"text", "text/plain"))])

    assert send("tab-aaaaaaaa", "1.txt").status_code == 200
    assert send("tab-aaaaaaaa", "2.txt").status_code == 200
    full = send("tab-aaaaaaaa", "3.txt")
    assert full.status_code == 413 and "You have too many" in full.json()["error"]["message"]
    assert send("tab-bbbbbbbb", "1.txt").status_code == 200  # another tab still has its own allowance
    assert uploads.waiting("tab-aaaaaaaa")[0] == 2 and uploads.waiting("tab-bbbbbbbb")[0] == 1
    # A malformed caller id shares the anonymous allowance rather than being trusted.
    assert send("../../x", "a.txt").status_code == 200 and uploads.waiting("anonymous")[0] == 1
