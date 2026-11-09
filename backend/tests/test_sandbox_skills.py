"""Skills and decks for GPT and the local model (python/sandbox_skills.py), with a fake model and a fake sandbox:
no Azure, no LibreOffice, no cost."""
from __future__ import annotations

import base64
import io
import tarfile

import anthropic
import pytest

from backend.app import shared  # noqa: F401  (puts python/ on sys.path)
from backend.app.services import decks as D

import sandbox_skills as S

MODEL = "gpt-5.4-mini"


def reply(*blocks, stop="tool_use"):
    return anthropic.types.Message(id="m", type="message", role="assistant", model=MODEL, content=list(blocks),
                                   stop_reason=stop, stop_sequence=None, usage={"input_tokens": 10, "output_tokens": 5})


def use(tool, **args):
    return {"type": "tool_use", "id": f"t_{tool}", "name": tool, "input": args}


class Script:
    """A model that answers with the replies it was given, in order, and records each request."""

    def __init__(self, *replies):
        self.replies, self.requests = list(replies), []
        self.messages = self

    def create(self, **params):
        self.requests.append({**params, "messages": list(params["messages"])})  # as sent, before the loop adds more
        return self.replies.pop(0)


class Box:
    """A sandbox that 'runs' a command by writing the deck it names into outputs/."""

    def __init__(self):
        self.commands = []

    def run(self, command, root, timeout):
        self.commands.append(command)
        (root / "outputs" / "deck.pptx").write_bytes(b"PK deck " + command.encode())
        return 0, "saved"


@pytest.fixture
def box(monkeypatch, tmp_path):
    fake = Box()
    monkeypatch.setattr(S, "WORKSPACES", tmp_path / "skill-runs")
    monkeypatch.setattr(S, "sandbox", lambda: (fake, RuntimeError))
    return fake


def test_the_model_reads_a_skill_runs_code_and_the_file_it_saves_in_outputs_is_reported(box):
    model = Script(reply(use("read_skill", name="pptx")),
                   reply(use("write_file", path="work/make.py", content="print('hi')")),
                   reply(use("bash", command="python work/make.py")),
                   reply({"type": "text", "text": "Made deck.pptx."}, stop="end_turn"))
    events = []
    result = S.run_in_sandbox(model, MODEL, ["pptx"], "Make a deck.", emit=events.append)
    assert "pptx" in model.requests[0]["system"] and "read_skill" in model.requests[0]["system"]  # names only
    assert "reference/editing.md" not in model.requests[0]["system"]  # the full skill is read only when asked for
    assert "reference/editing.md" in model.requests[1]["messages"][-1]["content"][0]["content"]
    assert [p.name for p in result.paths.values()] == ["deck.pptx"] and result.file_ids == list(result.paths)
    assert (S.WORKSPACES / result.container_id / "work" / "make.py").read_text() == "print('hi')"
    assert [e["name"] for e in events if e["type"] == "step"] == ["read_skill", "write_file", "bash"]


def test_a_follow_up_finds_the_same_workspace_and_a_path_outside_it_is_refused(box):
    first = S.run_in_sandbox(Script(reply({"type": "text", "text": "ok"}, stop="end_turn")), MODEL, ["pptx"], "hi",
                             emit=lambda e: None)
    model = Script(reply(use("write_file", path="../escape.txt", content="x")),
                   reply({"type": "text", "text": "ok"}, stop="end_turn"))
    again = S.run_in_sandbox(model, MODEL, ["pptx"], "more", emit=lambda e: None, history=first.messages,
                             container_id=first.container_id)
    assert again.container_id == first.container_id
    result = model.requests[1]["messages"][-1]["content"][0]
    assert result["is_error"] and "outside the workspace" in result["content"]


def test_without_a_sandbox_the_page_is_told_to_choose_claude(monkeypatch):
    coding = __import__("importlib").import_module("19_coding_agent")
    monkeypatch.setattr(coding, "SANDBOX", None)
    with pytest.raises(S.NeedsClaude, match="Choose a Claude model"):
        S.sandbox()


def test_an_attached_picture_is_shown_to_the_model_and_again_beside_the_slides_it_checks():
    png = D.Upload("sample-slide.png", b"\x89PNG fake")
    pictures = D.references([png, D.Upload("notes.txt", b"x")])
    message = D.sandbox_message("Make a slide like this.", ["inputs/sample-slide.png"], None, pictures)
    assert [b["type"] for b in message] == ["text", "text", "image"]
    assert base64.b64decode(message[2]["source"]["data"]) == b"\x89PNG fake"
    claude = D.user_message("Like this.", [(png, "file_1")], None)
    assert [b["type"] for b in claude] == ["text", "text", "image", "container_upload"]  # Claude sees it too
    review = D.review_message("deck.pptx", [(1, b"\x89PNG slide")], [], 0, last=False, refs=pictures)
    assert sum(b["type"] == "image" for b in review) == 2 and "look to match" in review[1]["text"]


def test_a_long_run_is_kept_inside_a_small_context_by_shortening_older_steps():
    big = "x" * 4000
    messages = [{"role": "user", "content": [{"type": "text", "text": "Make a deck."},
                                             {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "a"}}]}]
    for n in range(10):
        messages += [{"role": "assistant", "content": [use("write_file", path=f"work/s{n}.py", content=big)]},
                     {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{n}", "content": f"run {n}\n" + big}]}]
    before = S.estimate_tokens(messages)
    assert S.fit_context(messages, before + 1) == 0  # under the budget: nothing changes
    shortened = S.fit_context(messages, 10000)
    assert shortened and S.estimate_tokens(messages) <= 10000 < before
    results = [m["content"][0]["content"] for m in messages if m["role"] == "user" and m["content"][0]["type"] == "tool_result"]
    assert results[0].startswith("run 0") and results[0].endswith(S.SHORTENED)  # the first lines survive
    assert results[-1] == "run 9\n" + big  # the latest result is whole
    assert messages[0]["content"][1]["type"] == "text"  # the old picture became a note
    assert S.context_budget("claude-haiku-5-5") is None and S.context_budget("gpt-5.4-mini") is None


def test_the_sandbox_sends_back_only_what_a_command_changed(tmp_path):
    server = __import__("importlib").import_module("19_coding_agent").sandbox_server()
    box, mine = tmp_path / "box", tmp_path / "mine"
    for root in (box, mine):
        (root / "inputs").mkdir(parents=True)
        (root / "inputs" / "deck.pptx").write_bytes(b"big deck" * 1000)
        (root / "old.txt").write_text("old")
    before = server.fingerprint(box)
    (box / "outputs").mkdir()
    (box / "outputs" / "deck-v2.pptx").write_bytes(b"new deck")
    (box / "old.txt").unlink()
    archive, deleted = server.pack_changes(box, before)
    server.apply_changes(mine, archive, deleted)
    assert deleted == ["old.txt"] and not (mine / "old.txt").exists()
    assert (mine / "outputs" / "deck-v2.pptx").read_bytes() == b"new deck"
    names = tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz").getnames()
    assert names == ["outputs/deck-v2.pptx"] and (mine / "inputs" / "deck.pptx").exists()  # the deck was not resent


def test_the_backend_sends_the_sandbox_only_what_changed_and_starts_again_when_it_loses_track(tmp_path):
    import threading
    from http.server import ThreadingHTTPServer

    coding = __import__("importlib").import_module("19_coding_agent")
    server = coding.sandbox_server()
    server.WORK = tmp_path / "sandbox"  # the sandbox's own folders, in the test's temporary folder
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        pool = coding.SessionPool(f"http://127.0.0.1:{httpd.server_address[1]}")
        sizes = []
        call = pool._call
        pool._call = lambda request, timeout: sizes.append(len(request.data)) or call(request, timeout)
        root = tmp_path / "project"
        (root / "inputs").mkdir(parents=True)
        (root / "inputs" / "deck.pptx").write_bytes(bytes(range(256)) * 20_000)  # 5 MB that does not compress
        assert pool.takes_changes()
        assert pool.run("echo one > out.txt", root, 30)[0] == 0
        assert (root / "out.txt").read_text() == "one\n"  # what the command made came back
        (root / "notes.txt").write_text("mine")
        assert pool.run("cat notes.txt out.txt", root, 30)[1] == "mineone\n"  # the change went in
        assert sizes[1] < sizes[0] / 50  # the second request carried the change, not the 5 MB deck again
        (next((server.WORK / "sessions").iterdir()) / ".synced").unlink()  # the session loses track
        assert pool.run("ls inputs", root, 30)[1].strip() == "deck.pptx"
        assert len(sizes) == 4 and sizes[3] > sizes[1] * 50  # refused once (409), then the whole project again
    finally:
        httpd.shutdown()
