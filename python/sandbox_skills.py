"""Agent Skills for GPT and the local model: the same files, made in the lab's own sandbox instead of Anthropic's container.

Claude's skills run in Anthropic's code-execution container, which only Claude can use. Here the model gets the same
idea with tools of our own. It sees each skill's name and description; read_skill gives it the rest of a skill's
SKILL.md only when a task needs it; bash runs its commands in the coding agent's sandbox. With LLM_LAB_SANDBOX=sessions
that is the Azure container (examples/coding-sandbox), which has python-pptx, openpyxl, python-docx, reportlab,
LibreOffice and poppler, as Anthropic's container does. Locally it is the operating system's sandbox, which needs those
installed on this machine.

Each conversation has a workspace folder: inputs/ (the user's files), work/ (kept between messages), outputs/ (what
reaches the user) and skills/ (copies of the skills, so their scripts can run). A file written or changed in outputs/
is reported as a made file, as Anthropic's container reports files saved to $OUTPUT_DIR. The run returns the same
SkillsResult and publishes the same events as run_with_skills in 12_agent_skills.py, so a page uses either.
"""
from __future__ import annotations

import hashlib
import importlib
import json
import re
import shutil
import time
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from common import cost_usd, create, describe_usage, ensure_answered, tool
from local_model import ModelUnavailable, NeedsClaude, is_local
from settings import ENV

SKILLS_DIR = Path(__file__).resolve().parent / "skills"
WORKSPACES = Path(__file__).resolve().parent.parent / "generated" / "skill-runs"
OUTPUTS = "outputs"
COMMAND_TIMEOUT = 300  # seconds; LibreOffice's first start in a new container is slow
MAX_RESULT = 6000  # characters of a command's output sent back to the model

SYSTEM = """You complete the user's task by writing and running code in a Linux workspace, using skills.
- Every bash command starts in the workspace root; paths such as inputs/, work/ and skills/ are relative to it, so do not cd elsewhere to find files. inputs/ holds the user's files. Keep scripts and drafts in work/, which stays between messages. Save each file meant for the user in outputs/; only files there reach them.
- Before you start on a kind of file, read its skill with read_skill and follow it.
- Run code with bash. Write files with write_file rather than long shell heredocs.
- Base the content on the user's request and files. Do not invent figures; if something is missing, say so.
- Your final reply is short: what you made, then anything you could not do."""


@dataclass
class Workspace:
    """One conversation's folder. Its id goes in SkillsResult.container_id, so a follow-up finds it again."""
    id: str = field(default_factory=lambda: uuid.uuid4().hex)

    @property
    def root(self) -> Path:
        return WORKSPACES / self.id

    def prepare(self, skills: list[str]) -> None:
        for d in ("inputs", "work", OUTPUTS):
            (self.root / d).mkdir(parents=True, exist_ok=True)
        for name in skills:
            target = self.root / "skills" / name
            if not target.exists():
                shutil.copytree(SKILLS_DIR / name, target, ignore=shutil.ignore_patterns("__pycache__"))

    def add_input(self, name: str, content: bytes) -> str:
        """Saves a file the user attached in inputs/, and returns its path in the workspace."""
        safe = re.sub(r"[^\w.\- ]", "_", Path(name).name).strip() or "file"
        (self.root / "inputs").mkdir(parents=True, exist_ok=True)
        (self.root / "inputs" / safe).write_bytes(content)
        return f"inputs/{safe}"

    def delete(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


def prune(keep: int = 50, max_age_s: float = 24 * 3600) -> None:
    """Deletes workspaces untouched for a day, and the oldest beyond `keep`, so made files do not pile up."""
    if not WORKSPACES.is_dir():
        return
    folders = sorted((d for d in WORKSPACES.iterdir() if re.fullmatch(r"[0-9a-f]{32}", d.name)),
                     key=lambda d: d.stat().st_mtime, reverse=True)
    for i, d in enumerate(folders):
        if i >= keep or time.time() - d.stat().st_mtime > max_age_s:
            shutil.rmtree(d, ignore_errors=True)


def workspace(container_id: str | None) -> Workspace:
    if container_id and re.fullmatch(r"[0-9a-f]{32}", container_id) and (WORKSPACES / container_id).is_dir():
        return Workspace(container_id)
    return Workspace()


def current_files(container_id: str | None, pattern: str) -> dict[str, Path]:
    """The files in a workspace's outputs/ matching a glob, by id: what is there now, changed or not."""
    if not container_id or not re.fullmatch(r"[0-9a-f]{32}", container_id):
        return {}
    out = WORKSPACES / container_id / OUTPUTS
    return {file_id(p): p for p in sorted(out.glob(pattern)) if p.is_file()}


def describe_skills(names: list[str]) -> str:
    """Each skill's name and description: all the model sees of a skill until it reads one."""
    lines = []
    for name in names:
        head = (SKILLS_DIR / name / "SKILL.md").read_text().split("---")[1]
        description = re.search(r"^description:\s*(.+)$", head, re.M)
        lines.append(f"- {name}: {description.group(1).strip() if description else ''}")
    return "Skills you can read with read_skill:\n" + "\n".join(lines)


def file_id(path: Path) -> str:
    """An id for one version of a made file: the same file changed later gets a new id."""
    digest = hashlib.sha256(str(path).encode() + b"\0" + path.read_bytes()).hexdigest()
    return f"sbx_{digest[:32]}"


TOOLS = [
    tool("bash", "Run a bash command in the workspace root, with a timeout of five minutes. Returns the exit code and "
                 "the output. Files saved in outputs/ reach the user.", {"command": {"type": "string"}}),
    tool("write_file", "Write a text file in the workspace, such as a script in work/. Creates folders as needed.",
         {"path": {"type": "string", "description": "relative to the workspace root"},
          "content": {"type": "string"}}),
    tool("read_skill", "Read a skill's full instructions.", {"name": {"type": "string"}}),
]


def sandbox() -> Any:
    """The coding agent's sandbox: the Azure container with LLM_LAB_SANDBOX=sessions, the OS sandbox otherwise."""
    coding = importlib.import_module("19_coding_agent")
    if coding.SANDBOX is None:
        raise NeedsClaude("No sandbox is set up to run code for GPT or the local model (LLM_LAB_SANDBOX). "
                          "Choose a Claude model, which uses Anthropic's container, or set up the sandbox.")
    return coding.SANDBOX, coding.ToolError


def check_running() -> None:
    """Before a run: a sandbox container on this machine must be up, or every command would fail one by one."""
    box, _ = sandbox()
    endpoint = getattr(box, "endpoint", "")
    if not endpoint.startswith(("http://127.0.0.1", "http://localhost")):
        return
    try:
        urllib.request.urlopen(f"{endpoint}/health", timeout=3).read()
    except OSError as exc:
        raise ModelUnavailable(f"The sandbox container is not running at {endpoint}. Start it with "
                               "./tools/sandbox.sh, or choose a Claude model.") from exc


class Runner:
    """Runs the tools for one turn and remembers which files in outputs/ it has already reported."""

    def __init__(self, ws: Workspace, skills: list[str], emit: Callable[[dict], None]):
        self.ws, self.skills, self.emit = ws, skills, emit
        self.box, self.tool_error = sandbox()
        self.seen = self._snapshot()
        self.made: dict[str, Path] = {}

    def _snapshot(self) -> dict[Path, str]:
        out = self.ws.root / OUTPUTS
        return {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.is_file()} \
            if out.is_dir() else {}

    def _new_files(self) -> list[str]:
        now = self._snapshot()
        fresh = [p for p, h in now.items() if self.seen.get(p) != h]
        self.seen = now
        ids = []
        for p in fresh:
            i = file_id(p)
            self.made[i] = p
            ids.append(i)
        return ids

    def call(self, name: str, args: dict) -> tuple[str, bool, list[str]]:
        """(result text, is_error, ids of files made) for one tool call."""
        if name == "read_skill":
            skill = str(args.get("name", "")).strip()
            self.emit({"type": "step", "name": "read_skill", "detail": skill})
            if skill not in self.skills:
                return f"No skill called {skill!r}. Skills: {', '.join(self.skills)}", True, []
            return (self.ws.root / "skills" / skill / "SKILL.md").read_text(), False, []
        if name == "write_file":
            rel = str(args.get("path", ""))
            target = (self.ws.root / rel).resolve()
            if not target.is_relative_to(self.ws.root.resolve()) or ".venv" in target.parts:
                return f"{rel} is outside the workspace.", True, []
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(str(args.get("content", "")))
            self.emit({"type": "step", "name": "write_file", "detail": rel})
            return f"Wrote {rel} ({target.stat().st_size:,} bytes).", False, self._new_files()
        if name == "bash":
            command = str(args.get("command", ""))
            self.emit({"type": "step", "name": "bash", "detail": command.strip().splitlines()[0][:110] if command.strip() else ""})
            try:
                code, output = self.box.run(command, self.ws.root, COMMAND_TIMEOUT)
            except self.tool_error as exc:
                self.emit({"type": "error", "text": str(exc)})
                return str(exc), True, []
            output = output.strip()
            self.emit({"type": "output", "return_code": code, "first_line": output.splitlines()[0][:100] if output else ""})
            made = self._new_files()
            text = f"exit code {code}\n{output[-MAX_RESULT:]}"
            if made:
                text += "\nNew or changed in outputs/: " + ", ".join(self.made[i].name for i in made)
            return text, code != 0, made
        return f"No tool called {name}.", True, []


KEEP_WHOLE = 4  # the latest tool results are never shortened
IMAGE_TOKENS = 1500  # roughly what one slide image costs in context


def _dict(block: Any) -> dict:
    return block if isinstance(block, dict) else block.model_dump(exclude_none=True)


def estimate_tokens(messages: list[dict]) -> int:
    """A cautious count: about 3 characters a token (code and XML run shorter than prose), and a fixed amount per
    image. Better too high than a request the server refuses."""
    total = 0
    for m in messages:
        content = m["content"]
        if isinstance(content, str):
            total += len(content) // 3
            continue
        for b in map(_dict, content):
            if b.get("type") == "image":
                total += IMAGE_TOKENS
            else:
                total += len(json.dumps(b, default=str)) // 3
    return total


def context_budget(model: str) -> int | None:
    """Tokens the conversation may reach before older steps are shortened, or None when the model's context is
    large enough not to need it (Claude, GPT). Room is left for the system prompt, tools and the reply."""
    return int(ENV.local_context * 0.5) if is_local(model) else None


SHORTENED = "\n[older output shortened to keep within the context]"


def _shorten(block: dict, latest: bool) -> dict | None:
    """The block with its bulk removed, or None when there is nothing to remove (or it must stay whole)."""
    kind = block.get("type")
    if kind == "tool_result" and not latest:
        content = block["content"]
        text = content if isinstance(content, str) else " ".join(x.get("text", "") for x in content if isinstance(x, dict))
        return None if text.endswith(SHORTENED) else {**block, "content": text[:240] + SHORTENED}
    if kind == "tool_use" and not latest:  # a script written to a file, or sent inline to bash
        field = {"write_file": "content", "bash": "command"}.get(block.get("name"))
        text = str((block.get("input") or {}).get(field, "")) if field else ""
        if len(text) <= 300 or text.endswith(SHORTENED):
            return None
        return {**block, "input": {**block["input"], field: text[:200] + SHORTENED}}
    if kind == "image" and not latest:
        return {"type": "text", "text": "[a picture from earlier in the conversation, removed to save context]"}
    return None


def fit_context(messages: list[dict], budget: int | None) -> int:
    """Shortens older steps, oldest first, until the conversation fits the budget, as Claude's context editing clears
    old tool results: command output down to its first lines, scripts already written to a note, earlier pictures to
    a line. The last message and the latest KEEP_WHOLE tool results stay whole. Returns how many blocks it shortened.
    Without this a small local model's context fills after a few dozen steps."""
    if budget is None or estimate_tokens(messages) <= budget:
        return 0
    results = [(i, j) for i, m in enumerate(messages) if isinstance(m["content"], list)
               for j, b in enumerate(m["content"]) if _dict(b).get("type") == "tool_result"]
    keep = set(results[-KEEP_WHOLE:])
    shortened = 0
    for i, m in enumerate(messages[:-1]):
        if isinstance(m["content"], str):
            continue
        blocks = [_dict(b) for b in m["content"]]
        changed = False
        for j, b in enumerate(blocks):
            latest = (i, j) in keep or i >= len(messages) - 3  # the last exchange stays as it is
            if (short := _shorten(b, latest)) is not None:
                blocks[j], changed = short, True
                shortened += 1
        if changed:
            messages[i] = {**m, "content": blocks}
            if estimate_tokens(messages) <= budget:
                break
    return shortened


def run_in_sandbox(client, model: str, skills: list[str], task: str | list[dict], max_rounds: int = 40,
                   emit: Callable[[dict], None] = print, on_response: Callable | None = None,
                   cancelled: Callable[[], bool] = lambda: False, *, history: list[dict] | None = None,
                   container_id: str | None = None, system: str | None = None) -> Any:
    """One user turn, as run_with_skills does it, with the work done in the lab's sandbox. Returns a SkillsResult
    whose container_id is the workspace's id and whose paths say where each made file is."""
    K = importlib.import_module("12_agent_skills")
    check_running()
    ws = workspace(container_id)
    ws.prepare(skills)
    runner = Runner(ws, skills, emit)
    messages: list[dict] = [*(history or []), {"role": "user", "content": task}]
    file_ids: list[str] = []
    total = 0.0
    prompt = f"{system or SYSTEM}\n\n{describe_skills(skills)}"
    budget = context_budget(model)
    if budget is not None:  # the system prompt and the tools take their share of every request too
        budget -= (len(prompt) + len(json.dumps(TOOLS))) // 3
    max_tokens = min(16000, ENV.local_context // 4) if is_local(model) else 16000
    for turn in range(1, max_rounds + 1):
        if cancelled():
            break
        if shortened := fit_context(messages, budget):
            emit({"type": "step", "name": "context", "detail": f"shortened {shortened} older steps to stay within "
                                                              f"{ENV.local_context:,} tokens"})
        resp = create(client, model=model, max_tokens=max_tokens, system=prompt, tools=TOOLS, messages=messages)
        if resp.stop_reason == "refusal":
            ensure_answered(resp)
        cost = cost_usd(resp.usage, model) or 0
        total += cost
        if on_response:
            on_response(resp)
        emit({"type": "request", "turn": turn, "stop_reason": resp.stop_reason,
              "usage": describe_usage(resp.usage, model), "cost": cost})
        for block in resp.content:
            if block.type == "text" and block.text.strip():
                emit({"type": "says", "text": block.text.strip()})
        messages.append({"role": "assistant", "content": resp.content})
        uses = [b for b in resp.content if b.type == "tool_use"]
        if not uses:
            break
        results = []
        for b in uses:
            text, error, made = runner.call(b.name, b.input if isinstance(b.input, dict) else {})
            file_ids += made
            results.append({"type": "tool_result", "tool_use_id": b.id, "content": text, **({"is_error": True} if error else {})})
        messages.append({"role": "user", "content": results})
    else:
        emit({"type": "paused", "text": f"Stopped after {max_rounds} requests."})
    return K.SkillsResult(file_ids, total, messages, ws.id, {i: runner.made[i] for i in file_ids})


def uses_sandbox(model: str) -> bool:
    """Whether a model's skills run here rather than in Anthropic's container: every model but Claude's."""
    return not model.startswith("claude-")


def available() -> bool:
    try:
        sandbox()
        return True
    except NeedsClaude:
        return False


OFFICE_SKILLS = ["pptx", "xlsx", "docx", "pdf"]
__all__ = ["OFFICE_SKILLS", "SYSTEM", "Workspace", "available", "current_files", "prune", "run_in_sandbox", "uses_sandbox", "workspace"]
