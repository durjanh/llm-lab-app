"""Live sessions of the coding agent in python/19_coding_agent.py, and runs of its twin on the Claude Agent SDK.

Each session is a copy of python/coding_project in generated/coding-agent/<id>/project and one CodingAgent, so a
follow-up request carries the conversation on in the same folder. The page answers the agent's permission prompts
through the run, sees each file and the diff, and can undo the last change. The Agent SDK run starts
examples/claude-agent-sdk/coding_agent_sdk.py in its own environment and relays its JSON events, answering its
prompts the same way.
"""
from __future__ import annotations

import base64
import json
import re
import shutil
import subprocess
import threading
import uuid
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ..core.errors import ApiError
from ..gateways.claude import ClaudeGateway
from ..settings import MODELS
from ..shared import CLAUDE_MODEL, DEFAULT_MODEL, ROOT, coding_script as C, is_local
from .runs import Run, RunRegistry, RunStreamer
from .spend import SpendTracker

MAX_SESSIONS = 6
MAX_FILE_BYTES = 200_000
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
SAMPLE = C.SAMPLES / "bakery-sales-2025.xlsx"
SDK_DIR = ROOT / "examples" / "claude-agent-sdk"
SDK_MODES = {"default": "default", "accept_edits": "acceptEdits", "plan": "plan", "bypass": "bypassPermissions",
             "auto": "auto"}  # the SDK script turns auto into bypassPermissions with Claude Code's sandbox on


@dataclass
class Session:
    id: str
    folder: Path
    agent: Any  # coding_script.CodingAgent
    workspace: str  # practice (the project with bugs) or files (the person's own)
    lock: threading.Lock = field(default_factory=threading.Lock)


class CodingService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, registry: RunRegistry, streamer: RunStreamer,
                 folder: Path, *, run_budget_usd: float, approval_timeout_s: float, sdk_dir: Path = SDK_DIR,
                 gpt: Any = None):
        self.claude, self.spend, self.registry, self.streamer, self.folder = claude, spend, registry, streamer, folder
        self.gpt = gpt  # the lab's Azure OpenAI gateway, when GPT deployments are configured
        self.run_budget_usd, self.approval_timeout_s = run_budget_usd, approval_timeout_s
        self.sdk_python, self.sdk_script = sdk_dir / ".venv" / "bin" / "python", sdk_dir / "coding_agent_sdk.py"
        self.sessions: OrderedDict[str, Session] = OrderedDict()
        self._lock = threading.Lock()

    def info(self) -> dict[str, Any]:
        return {"models": list(dict.fromkeys([*MODELS, *self.gpt_models()])), "default_model": DEFAULT_MODEL, "gpt_models": self.gpt_models(),
                "tasks": C.TASKS, "workspaces": {k: tasks for k, (_, tasks) in C.WORKSPACES.items()},
                "modes": C.MODES, "sdk": self.sdk_python.exists(), "sample": SAMPLE.name,
                "screenshot": C.find_chrome() is not None, "sandbox": C.SANDBOX.kind if C.SANDBOX else None,
                "rules": {"deny": C.DENY, "allow": C.ALLOW, "auto_deny": C.AUTO_DENY}}

    def gpt_models(self) -> list[str]:
        """GPT deployments the agent can use: chat models, not image or embedding ones."""
        return [m for m in (self.gpt.models if self.gpt else []) if C.is_gpt(m) and "image" not in m]

    def _model(self, model: str | None) -> str:
        model = model or DEFAULT_MODEL
        if model not in MODELS and model not in self.gpt_models():
            raise ApiError(400, "invalid_request", f"model must be one of: {', '.join(dict.fromkeys([*MODELS, *self.gpt_models()]))}")
        return model

    # ----- sessions -----
    def _session(self, session_id: str | None, model: str, workspace: str = "practice") -> Session:
        with self._lock:
            if session_id and session_id in self.sessions:
                return self.sessions[session_id]
            sid = uuid.uuid4().hex  # also the key to the session's downloads, so not guessable
            folder = C.new_project(self.folder / sid / "project", C.WORKSPACES[workspace][0])
            s = Session(sid, folder, C.CodingAgent(self.claude.client, model, folder), workspace)
            self.sessions[sid] = s
            while len(self.sessions) > MAX_SESSIONS:
                _, old = self.sessions.popitem(last=False)
                shutil.rmtree(old.folder.parent, ignore_errors=True)
            return s

    def _get(self, session_id: str) -> Session:
        s = self.sessions.get(session_id)
        if s is None:
            raise ApiError(404, "not_found", "That session has ended. Start a new one.")
        return s

    def state(self, session_id: str) -> dict[str, Any]:
        """The folder as it is now: files (changed or new), files deleted, the diff, the to-do list, the checkpoints."""
        s = self._get(session_id)
        a, ws = s.agent, s.agent.ws
        files = ws.files()

        def changed(f: str) -> bool:
            return ws.path(f).read_text(encoding="utf-8", errors="replace") != ws.original.get(f)
        return {"session_id": s.id, "workspace": s.workspace, "mode": a.mode,
                "files": [{"path": f, "new": f not in ws.original, "changed": changed(f)} for f in files],
                "deleted": sorted(set(ws.original) - set(files)), "diff": ws.diff(), "todos": a.todos,
                "checkpoints": [{"id": c.id, "path": c.path, "tool": c.tool} for c in ws.checkpoints],
                "turns": a.turns, "cost": round(a.spent, 4)}

    def file(self, session_id: str, path: str) -> dict[str, Any]:
        ws = self._get(session_id).agent.ws
        try:
            p = ws.path(path)
        except C.ToolError as exc:
            raise ApiError(400, "bad_path", str(exc)) from exc
        if not p.is_file():
            raise ApiError(404, "not_found", f"No file {path}.")
        if media_type := C.IMAGE_TYPES.get(p.suffix.lower()):
            return {"path": ws.rel(p), "content": "", "original": None,
                    "image": f"data:{media_type};base64,{base64.b64encode(p.read_bytes()[:C.MAX_IMAGE_BYTES]).decode()}"}
        data = p.read_bytes()[:MAX_FILE_BYTES]
        return {"path": ws.rel(p), "content": data.decode("utf-8", errors="replace"),
                "original": ws.original.get(ws.rel(p))}

    def create(self, workspace: str) -> dict[str, Any]:
        """A session before its first request, so files can be added to it."""
        return self.state(self._session(None, DEFAULT_MODEL, workspace).id)

    def add_file(self, session_id: str, name: str, content: bytes) -> dict[str, Any]:
        """Puts a file in inputs/ and tells the agent at its next request. The file counts as part of the starting
        point, so it is not shown as a change."""
        s = self._get(session_id)
        if s.workspace != "files":
            raise ApiError(400, "invalid_request", "Files can be added to a Your files session only.")
        if s.lock.locked():
            raise ApiError(409, "busy", "The agent is working. Add files when it has finished.")
        if len(content) > MAX_UPLOAD_BYTES:
            raise ApiError(413, "too_large", "Files can be up to 20 MB.")
        safe = re.sub(r"[^\w.\- ]", "_", Path(name).name).strip(" .") or "file"
        ws = s.agent.ws
        path = ws.path(f"inputs/{safe}")
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(content)
        rel = ws.rel(path)
        ws.original[rel] = path.read_text(encoding="utf-8", errors="replace")
        s.agent.notes.append(f"<system-reminder>The person added {rel} ({len(content) / 1024:,.0f} KB).</system-reminder>")
        return self.state(session_id)

    def add_sample(self, session_id: str) -> dict[str, Any]:
        return self.add_file(session_id, SAMPLE.name, SAMPLE.read_bytes())

    def download(self, session_id: str, path: str) -> tuple[bytes, str]:
        """A file from the session, for a download link: a deck, a workbook, a chart."""
        ws = self._get(session_id).agent.ws
        try:
            p = ws.path(path)
        except C.ToolError as exc:
            raise ApiError(400, "bad_path", str(exc)) from exc
        if not p.is_file() or ws.rel(p).split("/")[0] in C.SKIP_DIRS:
            raise ApiError(404, "not_found", f"No file {path}.")
        return p.read_bytes(), p.name

    def undo(self, session_id: str) -> dict[str, Any]:
        s = self._get(session_id)
        if s.lock.locked():
            raise ApiError(409, "busy", "The agent is working. Stop it first, then undo.")
        cp = s.agent.undo()
        if cp is None:
            raise ApiError(400, "nothing_to_undo", "There is no change to undo.")
        return {"undone": {"id": cp.id, "path": cp.path, "tool": cp.tool}, **self.state(session_id)}

    # ----- the hand-built harness -----
    def run(self, prompt: str, session_id: str | None, mode: str, model: str | None) -> Iterator[str]:
        model = self._model(model)
        s = self._session(session_id, model)
        if not s.lock.acquire(blocking=False):
            raise ApiError(409, "busy", "The agent is still working on the last request.")
        run = Run(self.approval_timeout_s)
        a = s.agent
        a.model, a.mode = model, mode
        a.budget = a.spent + min(self.run_budget_usd, self.spend.remaining_usd)  # this request's share, not the session's
        a._emit, a._approve, a.cancelled = run.publish, run.ask, run.cancelled  # events and prompts go to the page
        a.on_response = lambda resp: self.spend.charge(resp, model)
        if C.is_gpt(model) and a.gpt_client is None:
            a.gpt_client = self.gpt.client()  # keyless: an Entra token from your Azure login or the managed identity

        def work() -> None:
            turns, calls, spent = a.turns, a.tool_calls, a.spent  # the session so far; final reports this request
            try:
                run.publish({"type": "session", "session_id": s.id, "mode": mode, "model": model})
                try:
                    answer, outcome = a.ask(prompt), "done"
                except C.StopRun as exc:
                    answer, outcome = None, f"stopped: {exc}"
                run.publish({"type": "final", "answer": answer, "outcome": outcome, "turns": a.turns - turns,
                             "tool_calls": a.tool_calls - calls, "cost": round(a.spent - spent, 4),
                             "spent_usd": round(self.spend.spent_usd, 4), "state": self.state(s.id)})
            finally:
                s.lock.release()

        return self.streamer.lines(run, work)

    def approve(self, run_id: str, tool_use_id: str, allow: bool) -> None:
        """The page's answer to a permission prompt, from either agent."""
        run = self.registry.get(run_id)
        if run is None or not run.answer(tool_use_id, allow):
            raise ApiError(404, "not_found", "That call is no longer waiting for an answer.")

    # ----- the same agent on the Claude Agent SDK -----
    def sdk_run(self, prompt: str, mode: str, model: str | None) -> Iterator[str]:
        """Runs the SDK twin in a fresh copy of the project and relays its events. Its prompts come to the page."""
        if not self.sdk_python.exists():
            raise ApiError(503, "sdk_missing", "The Agent SDK example is not installed. In examples/claude-agent-sdk run: "
                                               "python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt")
        model = model or CLAUDE_MODEL
        if C.is_gpt(model) or is_local(model):
            raise ApiError(400, "invalid_request", "The Agent SDK runs Claude Code, which uses Claude models only. "
                                                   "Use the hand-built harness for GPT or the local model.")
        run = Run(self.approval_timeout_s)
        folder = C.new_project(self.folder / f"sdk-{run.id[:10]}" / "project")
        ws = C.Workspace(folder)  # remembers the files as they were, for the diff at the end
        budget = min(self.run_budget_usd, self.spend.remaining_usd)

        def work() -> None:
            argv = [str(self.sdk_python), str(self.sdk_script), "--json", "--folder", str(folder),
                    "--mode", SDK_MODES[mode], "--model", model, "--budget", f"{budget:.3f}", prompt]
            proc = subprocess.Popen(argv, cwd=self.sdk_script.parent, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, bufsize=1)
            threading.Thread(target=lambda: run.cancelled.wait() and proc.poll() is None and proc.kill(),
                             daemon=True).start()
            final = False
            try:
                run.publish({"type": "session", "session_id": None, "mode": mode, "model": model, "sdk": True})
                for line in proc.stdout or []:
                    try:
                        e = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if e.get("type") == "approval":  # the SDK's can_use_tool is waiting on stdin
                        block = SimpleNamespace(id=e["id"], name=e["name"], input=e["input"])
                        allow = run.ask(block, e.get("who", "agent"), e.get("depth", 0), e.get("reason", ""))
                        proc.stdin.write(json.dumps({"id": e["id"], "allow": allow}) + "\n")
                        proc.stdin.flush()
                        continue
                    if e.get("type") == "final":
                        final = True
                        self.spend.charge_usd(float(e.get("cost") or 0), f"Agent SDK run ({model})")
                        e |= {"spent_usd": round(self.spend.spent_usd, 4), "diff": ws.diff()}
                    run.publish(e)
                proc.wait(timeout=10)
                if not final and not run.cancelled.is_set():
                    err = (proc.stderr.read() if proc.stderr else "").strip().splitlines()
                    run.publish({"type": "error", "message": "The Agent SDK run ended without a result. "
                                                             + (err[-1] if err else f"Exit code {proc.returncode}.")})
            finally:
                if proc.poll() is None:
                    proc.kill()
                shutil.rmtree(folder.parent, ignore_errors=True)

        return self.streamer.lines(run, work)
