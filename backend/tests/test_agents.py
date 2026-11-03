"""Live harness and skills routes, against a scripted fake Claude client: no network, no API key, no cost."""
from __future__ import annotations

import json
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from anthropic.types import Message

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services.harness import WEB_PERMISSIONS
from backend.app.services.runs import Run
from backend.app.settings import Settings
from backend.app.shared import harness_script as H
from backend.tests.test_api import LAB, make_client

HARNESS_PROMPT = "You answer questions about numbers"
BASH_PROMPT = "You do the task by running shell commands"


def reply(content: list[dict], stop_reason: str) -> Message:
    return Message.model_validate({
        "id": "msg_test", "type": "message", "role": "assistant", "model": "claude-haiku-5-5", "content": content,
        "stop_reason": stop_reason, "stop_sequence": None, "usage": {"input_tokens": 500, "output_tokens": 50},
        "container": {"id": "container_1", "expires_at": "2026-10-28T12:00:00Z"},
    })


def tool_use(id: str, name: str, **input: Any) -> dict:
    return {"type": "tool_use", "id": id, "name": name, "input": input}


class ScriptedMessages:
    """Answers each agent from its own script, picked by its system prompt."""

    def __init__(self, scripts: dict[str, list[Message]]):
        self.scripts = {key: iter(replies) for key, replies in scripts.items()}
        self.calls: list[dict] = []

    def create(self, **params: Any) -> Message:
        self.calls.append(params)
        key = "skills" if "container" in params else next(k for k in self.scripts if params["system"].startswith(k))
        return next(self.scripts[key])


class Files:
    def retrieve_metadata(self, file_id: str) -> Any:
        return SimpleNamespace(filename="../numbers.xlsx", size_bytes=5)

    def download(self, file_id: str) -> Any:
        return SimpleNamespace(read=lambda: b"xlsx!")


def fake_client(scripts: dict[str, list[Message]]) -> Any:
    return SimpleNamespace(messages=ScriptedMessages(scripts), files=Files(),
                           models=SimpleNamespace(retrieve=lambda model: {"id": model}))


def client_with(fake: Any, tmp_path: Path, **settings: Any) -> TestClient:
    """Like make_client, with some settings changed."""
    app = create_app(Settings(port=8000, frontend_dist=tmp_path / "no-dist", models_dir=tmp_path / "no-models", **settings),
                     client=fake)
    return TestClient(app, base_url="http://localhost:8000")


def events(response) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def test_harness_run_streams_each_step_and_charges(tmp_path: Path) -> None:
    fake = fake_client({HARNESS_PROMPT: [
        reply([tool_use("toolu_1", "multiply", a=3, b=3)], "tool_use"),
        reply([{"type": "text", "text": "3 × 3 = 9."}], "end_turn"),
    ]})
    client = make_client(fake, tmp_path)
    r = client.post("/api/harness/run", json={"scenario": "chain", "number": 3}, headers=LAB)
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
    ev = events(r)
    assert [e["type"] for e in ev] == ["run", "task", "request", "tool_use", "result", "request", "final"]
    assert ev[1]["task"].startswith("Take 3.") and len(ev[1]["tools"]) == 10
    assert ev[4]["content"] == "9" and not ev[4]["is_error"]
    assert ev[-1]["answer"] == "3 × 3 = 9." and ev[-1]["outcome"] == "done"
    history = fake.messages.calls[1]["messages"]  # the same list the harness keeps appending to
    assert [m["role"] for m in history[:3]] == ["user", "assistant", "user"]
    assert history[2]["content"] == [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "9"}]
    assert client.get("/api/status").json()["calls"] == 2


def test_bash_command_nobody_answers_is_refused(tmp_path: Path) -> None:
    fake = fake_client({
        HARNESS_PROMPT: [reply([tool_use("toolu_1", "bash_agent", task="Run expr 2 + 2.")], "tool_use"),
                         reply([{"type": "text", "text": "The command was refused."}], "end_turn")],
        BASH_PROMPT: [reply([tool_use("toolu_2", "bash", command="expr 2 + 2")], "tool_use"),
                      reply([{"type": "text", "text": "Refused."}], "end_turn")],
    })
    client = client_with(fake, tmp_path, approval_timeout_s=0.2)
    ev = events(client.post("/api/harness/run", json={"scenario": "bash"}, headers=LAB))
    approval = next(e for e in ev if e["type"] == "approval")
    assert approval["input"] == {"command": "expr 2 + 2"} and approval["reason"] == "no rule matches"
    done = next(e for e in ev if e["type"] == "approval_done")
    assert done == {"type": "approval_done", "id": "toolu_2", "allow": False, "timed_out": True}
    refused = next(e for e in ev if e["type"] == "result" and e["name"] == "bash")
    assert refused["is_error"] and "a person decided" in refused["content"]


def test_rm_is_denied_before_anyone_is_asked() -> None:
    assert H.permission("bash", {"command": "rm -rf build"}, WEB_PERMISSIONS)[0] == "deny"
    assert H.permission("bash", {"command": "expr 2 + 2"}, WEB_PERMISSIONS)[0] == "ask"
    assert H.permission("multiply", {}, WEB_PERMISSIONS)[0] == "allow"


def test_approve_answers_a_waiting_command(tmp_path: Path) -> None:
    client = make_client(fake_client({}), tmp_path)
    registry = client.app.state.container.harness.registry
    run = Run()
    registry.add(run)
    result: list[bool] = []
    waiting = threading.Thread(target=lambda: result.append(
        run.ask(SimpleNamespace(id="toolu_9", name="bash", input={"command": "date"}), "bash_agent 1", 1, "ask")))
    waiting.start()
    run.next_event(timeout=2)  # the approval event: the command is now waiting
    r = client.post("/api/harness/approve", json={"run_id": run.id, "tool_use_id": "toolu_9", "allow": True}, headers=LAB)
    waiting.join(timeout=2)
    registry.remove(run.id)
    assert r.json() == {"ok": True} and result == [True]
    again = client.post("/api/harness/approve", json={"run_id": run.id, "tool_use_id": "toolu_9", "allow": True}, headers=LAB)
    assert again.status_code == 404


def test_skill_run_lists_its_files_and_only_those_download(tmp_path: Path) -> None:
    fake = fake_client({"skills": [reply([
        {"type": "server_tool_use", "id": "srvtoolu_1", "name": "bash_code_execution", "input": {"command": "python make.py"}},
        {"type": "bash_code_execution_tool_result", "tool_use_id": "srvtoolu_1", "content": {
            "type": "bash_code_execution_result", "stdout": "saved", "stderr": "", "return_code": 0,
            "content": [{"type": "bash_code_execution_output", "file_id": "file_1"}]}},
        {"type": "text", "text": "numbers.xlsx is ready."},
    ], "end_turn")]})
    client = make_client(fake, tmp_path)
    ev = events(client.post("/api/skills/run", json={"skill": "xlsx", "upto": 10}, headers=LAB))
    assert [e["type"] for e in ev] == ["run", "task", "request", "step", "output", "says", "files"]
    assert fake.messages.calls[0]["container"] == {"skills": [{"type": "anthropic", "skill_id": "xlsx", "version": "latest"}]}
    assert ev[-1]["files"] == [{"id": "file_1", "name": "numbers.xlsx", "size_bytes": 5}]
    r = client.get("/api/skills/files/file_1", headers=LAB)
    assert r.content == b"xlsx!" and 'filename="numbers.xlsx"' in r.headers["content-disposition"]
    assert client.get("/api/skills/files/file_someone_else", headers=LAB).status_code == 404


@pytest.mark.parametrize("path", ["/api/harness/run", "/api/skills/run", "/api/harness/approve"])
def test_live_routes_only_answer_the_lab_pages(tmp_path: Path, path: str) -> None:
    r = make_client(fake_client({}), tmp_path).post(path, json={}, headers={"host": "localhost:8000"})
    assert r.status_code == 403
