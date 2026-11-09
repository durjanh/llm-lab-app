"""A coding agent built the way Claude Code is built, with no agent framework.

Companion to the Coding agent lab (Lab 46). 11_harness_loop.py shows the loop, permissions, hooks, sub-agents and
compaction on toy tools. This script puts the same loop to work on a real project folder, with the parts that make
it a coding agent rather than a chat with tools:

  file tools    read_file, write_file, edit_file, glob, grep. Every path must stay inside the project folder.
                edit_file replaces one exact string that appears once, and only in a file the agent has read
                since it last changed: so it cannot edit blind, or overwrite a change it has not seen.
  eyes          read_file on a PNG, JPEG, GIF or WebP returns the picture itself, as an image block in the tool
                result, so Claude sees it. screenshot renders an .html or .svg file from the project in headless
                Chrome and returns the picture and the console messages. That is all a screenshot is in Claude
                Code too: a tool makes an image file, and reading it puts the image in the conversation.
  bash          a real shell in the project folder, with a timeout and capped output. A compound command
                (a && b, a | b) is split, and every part must pass the rules.
  permissions   deny rules first, always, in every mode. Then the mode: default asks before every edit and every
                command not on the allow list; accept_edits lets edits through; plan allows only reading;
                bypass allows the rest. A person answers what is left.
  hooks         before a call (protect .env and .git), after it (a syntax check after editing Python), and Stop: an
                agent that changed files is sent back to work until the tests pass, at most three times.
  auto mode     no approvals at all. bash is the general tool: when no tool does the job, the agent writes a script
                or installs a package into the project's own .venv. That is safe because commands run in a sandbox
                (sandbox-exec on macOS, bubblewrap on Linux; LLM_LAB_SANDBOX): writes only in the project, no reading
                of the home folder or .env, a clean environment without the API key. Without a sandbox, auto mode
                keeps the full deny rules.
  CLAUDE.md     the project's instructions, read once into the system prompt.
  to-do list    todo_write, for work in several steps; the page shows it as it changes.
  checkpoints   the file as it was before every edit, so `undo` puts it back.
  explore       a sub-agent with only the reading tools and an empty context; it reports back in a few lines.
  context       the system prompt, tools and conversation are cached; long tool output is cut to its start and
                end; when the conversation grows past --clear-at tokens, older tool results are cleared in one go
                (clearing on every turn would break the cache every turn). A cleared file must be read again
                before it is edited.

The model is Claude, or a GPT deployment in Azure OpenAI (--model gpt-5.4-mini): the conversation is kept in Claude's
format and translated for each GPT call, so the harness, the tools and the sandbox are the same for both.

The tool list never changes during a session, plan mode included: changing it would invalidate the cache.
A change of mode is sent as a note in the next message instead, as Claude Code does.

    python 19_coding_agent.py                         # fix the failing tests in coding_project, asking before edits
    python 19_coding_agent.py --task feature --mode accept_edits
    python 19_coding_agent.py --task plan --mode plan
    python 19_coding_agent.py --task cleanup          # asks for things the deny rules refuse
    python 19_coding_agent.py --task page --mode accept_edits --keep   # builds a page and checks it by eye
    python 19_coding_agent.py --task excel --mode auto --keep          # needs a package nobody installed
    python 19_coding_agent.py --files analysis_samples/bakery-sales-2025.xlsx --task deck --mode auto --keep
    python 19_coding_agent.py "Explain read_csv" --keep
"""
from __future__ import annotations

import argparse
import base64
import difflib
import fnmatch
import importlib.util
import io
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from common import cost_usd, create, ensure_answered, make_client, model_argument, run, text_of
from settings import ENV

PROJECT = Path(__file__).resolve().parent / "coding_project"  # the practice project, with its deliberate bugs
FILES_PROJECT = Path(__file__).resolve().parent / "analysis_project"  # an empty workspace for the person's own files
SAMPLES = Path(__file__).resolve().parent / "analysis_samples"  # an invented workbook to try it with
MAX_OUTPUT = 12_000  # characters of one tool result sent to the model; longer output keeps its start and end
MAX_READ_LINES = 400
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
MAX_IMAGE_EDGE = 1568  # Claude shrinks anything larger itself; shrinking first saves the upload and the tokens
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # Claude's limit for one base64 image
PAGES = (".html", ".htm", ".svg")  # what screenshot renders
CHROME_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"]
SKIP_DIRS = {".git", "__pycache__", ".venv", "node_modules", ".pytest_cache"}
# Where the project sits in a cloud sandbox, as command output shows it: a container of its own (A), or a folder
# per session in a shared one (B).
SESSION_ROOT = re.compile(r"^/work/(?:sessions/[A-Za-z0-9_-]+/)?project(?:/|$)")
CLEARED = "[Cleared by the harness to keep the context small. Read the file again if you need it.]"


class ToolError(Exception):
    """A failure the model should hear about, returned as an error tool result."""


class StopRun(Exception):
    """The harness ends the run: the turn limit, the budget, or the person pressed stop."""


# --- The project folder ------------------------------------------------------

@dataclass
class Checkpoint:
    id: int
    path: str
    before: str | None  # None: the file did not exist
    tool: str


class Workspace:
    """The folder the agent works in. Every path is resolved inside it; every write is checkpointed first."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.checkpoints: list[Checkpoint] = []
        self.original = {rel: self.path(rel).read_text(encoding="utf-8", errors="replace") for rel in self.files()}

    def path(self, rel: str) -> Path:
        if m := SESSION_ROOT.match(rel):  # the project as a cloud sandbox names it
            rel = rel[m.end():] or "."
        p = (self.root / rel).resolve()
        if p != self.root and not p.is_relative_to(self.root):
            raise ToolError(f"{rel} is outside the project folder. Use a path inside it.")
        return p

    def rel(self, p: Path) -> str:
        return p.relative_to(self.root).as_posix() or "."

    def files(self) -> list[str]:
        out = []
        for dirpath, dirs, names in os.walk(self.root):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            out += [self.rel(Path(dirpath) / n) for n in sorted(names)]
        return out

    def save(self, rel: str, text: str, tool: str) -> Checkpoint:
        p = self.path(rel)
        cp = Checkpoint(len(self.checkpoints) + 1, rel, p.read_text(encoding="utf-8") if p.exists() else None, tool)
        self.checkpoints.append(cp)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return cp

    def fingerprint(self) -> dict[str, tuple[float, int]]:
        """Each file's modification time and size, to tell whether anything changed, by a tool or by bash."""
        return {f: (s.st_mtime, s.st_size) for f in self.files() if (s := self.path(f).stat())}

    def undo(self) -> Checkpoint | None:
        """Puts back the file the last write changed, or removes it if the write created it."""
        if not self.checkpoints:
            return None
        cp = self.checkpoints.pop()
        p = self.path(cp.path)
        if cp.before is None:
            p.unlink(missing_ok=True)
        else:
            p.write_text(cp.before, encoding="utf-8")
        return cp

    def diff(self) -> str:
        """Every change since the session started, as one unified diff."""
        out = []
        for rel in sorted(set(self.original) | set(self.files())):
            p = self.path(rel)
            now = p.read_text(encoding="utf-8", errors="replace") if p.exists() else None
            was = self.original.get(rel)
            if now != was and (binary(p) or Path(rel).suffix.lower() in IMAGE_TYPES):
                out.append(f"Binary file {rel} {'added' if was is None else 'deleted' if now is None else 'changed'}\n")
            elif now != was:
                out.append(unified(rel, was, now))
        return "".join(out)


def binary(p: Path) -> bool:
    """An image, a workbook, a zip: what a diff cannot show. Text never holds a NUL byte."""
    return p.is_file() and b"\0" in p.read_bytes()[:8192]


def unified(rel: str, before: str | None, after: str | None) -> str:
    return "".join(difflib.unified_diff((before or "").splitlines(keepends=True), (after or "").splitlines(keepends=True),
                                        f"a/{rel}" if before is not None else "/dev/null",
                                        f"b/{rel}" if after is not None else "/dev/null"))


def numbered(lines: list[str], start: int) -> str:
    return "".join(f"{i:>6}\t{line}" for i, line in enumerate(lines, start))


def capped(text: str) -> str:
    if len(text) <= MAX_OUTPUT:
        return text
    half = MAX_OUTPUT // 2
    return f"{text[:half]}\n[... {len(text) - MAX_OUTPUT:,} characters cut by the harness ...]\n{text[-half:]}"


# --- The tools ---------------------------------------------------------------

@dataclass
class Change:
    """A write the agent asked for, worked out before anyone is asked to approve it."""
    path: str
    before: str | None
    after: str
    note: str = ""


@dataclass
class Context:
    """What one agent has seen: the files it has read, with their modification time when it read them."""
    reads: dict[str, float] = field(default_factory=dict)
    read_ids: dict[str, str] = field(default_factory=dict)  # tool_use_id -> path, so clearing a read forgets it


def image_result(caption: str, data: bytes, media_type: str) -> list[dict]:
    """A tool result Claude sees as a picture: a line of text, then the image. Large images are shrunk first,
    with Pillow when it is installed. An image costs about width × height / 750 input tokens."""
    size = ""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        if max(img.size) > MAX_IMAGE_EDGE:
            img.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
            buf = io.BytesIO()
            img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB").save(buf, "PNG")
            data, media_type = buf.getvalue(), "image/png"
        size = f", {img.width}×{img.height} (about {img.width * img.height // 750:,} tokens)"
    except ImportError:
        pass
    except OSError as exc:  # Pillow could not read it
        raise ToolError(f"{caption} is not an image Pillow can read: {exc}")
    if len(data) > MAX_IMAGE_BYTES:
        raise ToolError(f"{caption} is larger than 5 MB. Make a smaller image.")
    return [{"type": "text", "text": caption + size},
            {"type": "image", "source": {"type": "base64", "media_type": media_type,
                                         "data": base64.b64encode(data).decode()}}]


def read_file(args: dict, agent: "CodingAgent", ctx: Context, call_id: str) -> str | list[dict]:
    p = agent.ws.path(args["path"])
    if p.is_dir():
        rel = agent.ws.rel(p)
        return "\n".join(f for f in agent.ws.files() if rel == "." or f.startswith(rel + "/")) or "(empty folder)"
    if not p.exists():
        raise ToolError(f"{args['path']} does not exist.")
    if p.suffix.lower() in IMAGE_TYPES:
        return image_result(agent.ws.rel(p), p.read_bytes(), IMAGE_TYPES[p.suffix.lower()])
    try:
        lines = p.read_text(encoding="utf-8").splitlines(keepends=True)
    except UnicodeDecodeError:
        raise ToolError(f"{args['path']} is not a text file.")
    start = max(1, int(args.get("offset") or 1))
    limit = min(int(args.get("limit") or MAX_READ_LINES), MAX_READ_LINES)
    part = lines[start - 1:start - 1 + limit]
    rel = agent.ws.rel(p)
    ctx.reads[rel] = p.stat().st_mtime
    ctx.read_ids[call_id] = rel
    more = f"\n[{len(lines) - (start - 1 + len(part))} more lines: read again with offset]" if start - 1 + len(part) < len(lines) else ""
    return (numbered(part, start) or "(empty file)") + more


def must_have_read(agent: "CodingAgent", ctx: Context, rel: str) -> None:
    """The rule that stops blind edits: read it first, and read it again if it changed since."""
    p = agent.ws.path(rel)
    seen = ctx.reads.get(agent.ws.rel(p))
    if seen is None:
        raise ToolError(f"Read {rel} before changing it.")
    if p.stat().st_mtime != seen:
        raise ToolError(f"{rel} has changed since you read it. Read it again first.")


def prepare_write(args: dict, agent: "CodingAgent", ctx: Context) -> Change:
    p = agent.ws.path(args["path"])
    rel = agent.ws.rel(p)
    before = None
    if p.exists():
        must_have_read(agent, ctx, rel)
        before = p.read_text(encoding="utf-8")
    return Change(rel, before, args["content"], "created" if before is None else "rewritten")


def prepare_edit(args: dict, agent: "CodingAgent", ctx: Context) -> Change:
    p = agent.ws.path(args["path"])
    rel = agent.ws.rel(p)
    if not p.exists():
        raise ToolError(f"{rel} does not exist. Use write_file to create it.")
    must_have_read(agent, ctx, rel)
    old, new = args["old_string"], args["new_string"]
    if old == new:
        raise ToolError("old_string and new_string are the same.")
    text = p.read_text(encoding="utf-8")
    n = text.count(old)
    if n == 0:
        raise ToolError(f"old_string is not in {rel}. Copy it exactly from the file, without the line numbers.")
    if n > 1 and not args.get("replace_all"):
        raise ToolError(f"old_string appears {n} times in {rel}. Include more of the surrounding lines so it is "
                        "unique, or set replace_all.")
    return Change(rel, text, text.replace(old, new) if args.get("replace_all") else text.replace(old, new, 1),
                  f"replaced {n if args.get('replace_all') else 1} occurrence{'s' if n > 1 and args.get('replace_all') else ''}")


def glob_files(args: dict, agent: "CodingAgent", ctx: Context, call_id: str) -> str:
    pattern = args["pattern"]
    hits = [f for f in agent.ws.files()
            if PurePosixPath(f).full_match(pattern) or ("/" not in pattern and fnmatch.fnmatch(PurePosixPath(f).name, pattern))]
    return "\n".join(hits[:200]) or "No files match."


def grep(args: dict, agent: "CodingAgent", ctx: Context, call_id: str) -> str:
    try:
        rx = re.compile(args["pattern"])
    except re.error as exc:
        raise ToolError(f"Not a valid regular expression: {exc}")
    base = agent.ws.rel(agent.ws.path(args.get("path") or "."))
    only = args.get("glob") or ""
    out = []
    for f in agent.ws.files():
        if base != "." and not (f == base or f.startswith(base + "/")):
            continue
        if only and not fnmatch.fnmatch(PurePosixPath(f).name, only):
            continue
        try:
            for i, line in enumerate(agent.ws.path(f).read_text(encoding="utf-8").splitlines(), 1):
                if rx.search(line):
                    out.append(f"{f}:{i}: {line.strip()[:200]}")
        except UnicodeDecodeError:
            continue
        if len(out) >= 100:
            out.append("[stopped at 100 matches: narrow the pattern or the path]")
            break
    return "\n".join(out) or "No matches."


def bash(args: dict, agent: "CodingAgent", ctx: Context, call_id: str) -> str:
    outside = contained(agent) and bool(args.get("outside_sandbox"))  # a person approved it: see permission()
    # Installing a program can take minutes: outside the sandbox, or in a cloud session where apt-get works.
    timeout = min(int(args.get("timeout") or 60), 900 if outside or (contained(agent) and SANDBOX.kind == "sessions") else 300)
    root = agent.ws.root
    if contained(agent) and not outside:
        code, output = SANDBOX.run(args["command"], root, timeout)
        if code == 0:
            record_installs(agent, args["command"])
    else:
        env = clean_env(PYTHONDONTWRITEBYTECODE="1", GIT_CEILING_DIRECTORIES=str(root.parent),
                        PATH=f"{Path(sys.executable).parent}{os.pathsep}{os.environ.get('PATH', '')}")
        try:
            proc = subprocess.run(args["command"], shell=True, cwd=root, capture_output=True, text=True,
                                  timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            raise ToolError(f"The command ran for more than {timeout} s and was stopped.")
        code, output = proc.returncode, proc.stdout + proc.stderr
        if code == 0 and outside:
            record_installs(agent, args["command"])  # brew install on this machine: there for every session
    output = output.strip() or "(no output)"
    return output if code == 0 else f"exit code {code}\n{output}"


# --- The sandbox (auto mode) ---------------------------------------------------------

LAB = PROJECT.parents[1]  # the lab repository: readable, except its .env
# Shared by every session, so what one agent fetches the next one finds: pip's download cache, and bin/ (on the
# PATH) for programs it downloads. The one place outside its project a contained command may write.
AGENT_TOOLS = LAB / "generated" / "agent-tools"
SECRET = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|CONNECTION|CREDENTIAL|ANTHROPIC|AZURE|OPENAI", re.I)


def clean_env(**extra: str) -> dict[str, str]:
    """The environment for the agent's commands, without the lab's keys and cloud settings: it needs none of them."""
    return {**{k: v for k, v in os.environ.items() if not SECRET.search(k)}, **extra}


@dataclass(frozen=True)
class Sandbox:
    """What lets auto mode run any command without asking: the operating system, not the prompt, keeps it in.

    A command may write only in the project folder and its temp folder, cannot read the home folder (keys, cloud
    logins, other projects) or the lab's .env, and gets a clean environment without the lab's API key. It may use
    the network, so pip and curl work. Claude Code's sandbox does the same with the same two tools, and also filters
    the network by domain through a proxy."""
    kind: str  # seatbelt (macOS sandbox-exec), bwrap (Linux bubblewrap), container (the session's own container)

    def argv(self, command: str, folder: Path, tmp: Path) -> list[str]:
        home, env = Path.home(), LAB / ".env"
        if self.kind == "seatbelt":
            q = json.dumps  # sandbox profile strings are quoted as JSON strings are
            return ["sandbox-exec", "-p", "\n".join([
                "(version 1)", "(allow default)",
                "(deny file-write*)",
                f'(allow file-write* (subpath {q(str(folder))}) (subpath {q(str(tmp))}) (subpath {q(str(AGENT_TOOLS))})'
                ' (subpath "/dev"))',
                f"(deny file-read* (subpath {q(str(home))}))",
                f"(allow file-read* (subpath {q(str(LAB))}) (subpath {q(str(folder))}) (subpath {q(str(tmp))}))",
                # Resolving a path looks up every folder above it, so those may be looked up, but not listed.
                "(allow file-read-metadata " + " ".join(
                    f"(literal {q(str(p))})" for p in {*LAB.parents, *folder.parents, *tmp.parents}) + ")",
                f"(deny file-read* (literal {q(str(env))}))"]), "/bin/bash", "-c", command]
        if self.kind == "bwrap":
            return ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", str(home),
                    "--ro-bind", str(LAB), str(LAB), "--bind", str(folder), str(folder), "--bind", str(tmp), str(tmp),
                    "--bind", str(AGENT_TOOLS), str(AGENT_TOOLS),
                    *(["--ro-bind", "/dev/null", str(env)] if env.exists() else []),
                    "--unshare-pid", "--die-with-parent", "/bin/bash", "-c", command]
        return ["/bin/bash", "-c", command]  # container: the session's container is the boundary

    def run(self, command: str, root: Path, timeout: int) -> tuple[int, str]:
        """Runs one command in the project, contained. A clean environment: no API key or cloud credentials, a home
        and temp folder of its own, and the project's .venv first on the PATH, so `python` and `pip` are the project's."""
        tmp = root.parent / "tmp"
        for d in (tmp / "home", AGENT_TOOLS / "bin", AGENT_TOOLS / "pip-cache"):
            d.mkdir(parents=True, exist_ok=True)
        venv = project_venv(root)
        env = {"PATH": os.pathsep.join([str(venv / "bin"), str(AGENT_TOOLS / "bin"), "/opt/homebrew/bin", "/usr/local/bin",
                                        "/usr/bin", "/bin", "/usr/sbin", "/sbin",
                                        "/Applications/LibreOffice.app/Contents/MacOS"]),  # once someone installs it
               "HOME": str(tmp / "home"), "TMPDIR": str(tmp), "PIP_CACHE_DIR": str(AGENT_TOOLS / "pip-cache"),
               "VIRTUAL_ENV": str(venv), "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1",
               "GIT_CEILING_DIRECTORIES": str(root.parent)}
        try:
            proc = subprocess.run(self.argv(command, root, tmp), cwd=root, capture_output=True, text=True,
                                  timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            raise ToolError(f"The command ran for more than {timeout} s and was stopped.")
        return proc.returncode, proc.stdout + proc.stderr


class SessionPool:
    """Commands run in a container of their own in Azure Container Apps: a dynamic session pool (a Hyper-V isolated
    container per agent session, made on first use and destroyed when idle), or a sandbox container app on the
    Consumption plan that every session shares, each in its own folder. Both run examples/coding-sandbox/server.py
    and speak the same protocol, so moving between them is a change of endpoint and scope. This is the sandbox for
    the cloud, where the backend's own container holds the managed identity and the API key and so must never run
    the agent's commands.

    The harness keeps the project, so checkpoints, diffs and the file tools are unchanged. For each command it sends
    the project (without .venv) to the session, which runs examples/coding-sandbox/server.py, and takes it back:
    only files whose content changed are written, so the agent's reads stay valid. The session keeps its .venv, so
    `pip install` lasts while it lives. Calls are signed with an Entra token for https://dynamicsessions.io (az login
    locally, the managed identity in Azure): for a pool, https://dynamicsessions.io with the Session Executor role;
    for the container app, its app registration's scope, checked by Container Apps' built-in sign-in. An http://localhost
    endpoint is a server.py run by hand, without a token, for trying it out."""
    kind = "sessions"

    def __init__(self, endpoint: str) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.ids: dict[Path, str] = {}  # project folder -> session identifier, random so it cannot be guessed
        # project folder -> (sync id, fingerprint) of what the session last had, so only changes are sent in
        self.synced: dict[Path, tuple[str, dict[str, str]]] = {}
        self._delta: bool | None = None  # whether the server takes changes only; asked once
        self._credential, self._token = None, None

    def token(self) -> str | None:
        if self.endpoint.startswith(("http://localhost", "http://127.0.0.1")):
            return None
        if self._token is None or self._token.expires_on - 300 < time.time():
            if self._credential is None:
                from azure.identity import DefaultAzureCredential
                self._credential = DefaultAzureCredential()
            # A session pool's own audience, or the sandbox container app's app registration (LLM_LAB_SESSIONS_SCOPE).
            self._token = self._credential.get_token(ENV.coding_sessions_scope or "https://dynamicsessions.io/.default")
        return self._token.token

    def run(self, command: str, root: Path, timeout: int) -> tuple[int, str]:
        # The first command of a session asks it to install what earlier sessions recorded; it does so once.
        setup = read_installed() if root not in self.ids else {}
        reply = self._send("run", root, {"command": command, "timeout": timeout, "delta": True,
                                         "setup": {k: v for k, v in setup.items() if k in ("pip", "apt")}},
                           timeout + 90 + (900 if setup else 0))
        archive = base64.b64decode(reply["archive"])
        if "deleted" in reply:  # only what the command changed: a big unchanged file is not sent back each time
            sandbox_server().apply_changes(root, archive, reply["deleted"])
        else:  # an older sandbox image sends the whole project
            sandbox_server().unpack(root, archive)
        self._in_step(root, reply)
        if reply.get("timed_out"):
            raise ToolError(f"The command ran for more than {timeout} s and was stopped.")
        return int(reply["returncode"]), reply["output"]

    def screenshot(self, root: Path, path: str, width: int, height: int) -> tuple[bytes, list[str]]:
        """The page rendered by Chromium in the session, next to the agent's other commands."""
        reply = self._send("screenshot", root, {"path": path, "width": width, "height": height}, 120)
        self._in_step(root, reply)
        return base64.b64decode(reply["png"]), reply.get("console", [])

    def _headers(self) -> dict:
        return {"Content-Type": "application/json", **({"Authorization": f"Bearer {t}"} if (t := self.token()) else {})}

    def takes_changes(self) -> bool:
        """Whether the server takes only what changed (GET /health says delta 2). An older image does not."""
        if self._delta is None:
            try:
                with urlopen(Request(f"{self.endpoint}/health", headers=self._headers()), timeout=30) as resp:
                    self._delta = json.loads(resp.read()).get("delta", 0) >= 2
            except (HTTPError, URLError, TimeoutError, OSError, ValueError):
                self._delta = False
        return self._delta

    def _in_step(self, root: Path, reply: dict) -> None:
        """After a reply is applied, the session and this folder match: remember what both now hold."""
        if reply.get("_sync"):
            self.synced[root] = (reply["_sync"], sandbox_server().fingerprint(root))

    def _send(self, route: str, root: Path, payload: dict, timeout: int) -> dict:
        """The project goes with every request, so the session always has the harness's latest files: all of it the
        first time, then only what changed since the last request, when the server takes that."""
        identifier = self.ids.setdefault(root, secrets.token_hex(16))
        server = sandbox_server()
        for whole in (False, True):
            sync = secrets.token_hex(8) if self.takes_changes() else None
            base = None if whole else self.synced.get(root)
            if base and sync:
                archive, removed = server.pack_changes(root, base[1])
                extra = {"since": base[0], "removed": removed}
            else:
                archive, extra = server.pack(root), {}
            body = json.dumps({**payload, **extra, **({"sync": sync} if sync else {}),
                               "archive": base64.b64encode(archive).decode()}).encode()
            self.synced.pop(root, None)  # out of step until this request succeeds
            try:
                reply = self._call(Request(f"{self.endpoint}/{route}?identifier={identifier}", body, self._headers(),
                                           method="POST"), timeout)
                return {**reply, "_sync": sync}
            except HTTPError as exc:
                if exc.code == 409 and extra:  # the session lost track (restarted, or idle too long): send it all
                    continue
                raise ToolError(f"The sandbox session could not do it: {exc.read().decode('utf-8', 'replace')[:300]}")
            except (URLError, TimeoutError, OSError) as exc:
                raise ToolError(f"The sandbox session could not do it: {exc}")
        raise ToolError("The sandbox session could not do it: it would not take the project.")

    def _call(self, request: Request, timeout: int) -> dict:
        """One call through the pool. A 202 means the pool is still working: poll its Location until the reply."""
        deadline = time.monotonic() + timeout
        with urlopen(request, timeout=timeout) as resp:
            status, location, data = resp.status, resp.headers.get("Location"), resp.read()
        while status == 202 and location and time.monotonic() < deadline:
            time.sleep(1)
            with urlopen(Request(location, headers={k: v for k, v in request.header_items()
                                                    if k.lower() == "authorization"}), timeout=60) as resp:
                status, location, data = resp.status, resp.headers.get("Location") or location, resp.read()
        if status != 200:
            raise TimeoutError(f"no reply from the sandbox session (HTTP {status})")
        return json.loads(data)


def sandbox_server():
    """examples/coding-sandbox/server.py, for its pack and unpack: one implementation at both ends of the wire."""
    if "coding_sandbox_server" not in sys.modules:
        spec = importlib.util.spec_from_file_location("coding_sandbox_server", LAB / "examples" / "coding-sandbox" / "server.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    return sys.modules["coding_sandbox_server"]


def find_sandbox(setting: str = ENV.coding_sandbox) -> Sandbox | SessionPool | None:
    """LLM_LAB_SANDBOX: auto finds sandbox-exec on macOS or a working bubblewrap on Linux (containers often block
    it); docker uses the sandbox image running in Docker on this machine (tools/sandbox.sh), with the same protocol
    as Azure; sessions uses the sandbox in Azure at LLM_LAB_SESSIONS_ENDPOINT; container trusts a per-session
    container; none, or nothing found, leaves auto mode with the deny rules."""
    if setting == "docker":
        return SessionPool(ENV.docker_sandbox_url)
    if setting == "sessions":
        return SessionPool(ENV.coding_sessions_endpoint) if ENV.coding_sessions_endpoint else None
    if setting == "container":
        return Sandbox("container")
    if setting in ("auto", "seatbelt") and sys.platform == "darwin" and shutil.which("sandbox-exec"):
        return Sandbox("seatbelt")
    if setting in ("auto", "bwrap") and shutil.which("bwrap"):
        try:
            if subprocess.run(["bwrap", "--ro-bind", "/", "/", "true"], capture_output=True, timeout=10).returncode == 0:
                return Sandbox("bwrap")
        except (OSError, subprocess.TimeoutExpired):
            pass
    return None


SANDBOX = find_sandbox()


def contained(agent: "CodingAgent") -> bool:
    return agent.mode == "auto" and SANDBOX is not None


def project_venv(root: Path) -> Path:
    """The project's own .venv, made the first time a contained command runs, so pip installs land there. It also
    sees the shared environment in agent-tools, so what earlier sessions installed imports at once. git is told to
    ignore it, so the agent cannot commit it by accident."""
    venv = root / ".venv"
    if not (venv / "bin" / "python").exists():
        subprocess.run([sys.executable, "-m", "venv", str(venv)], capture_output=True, check=True, timeout=120)
        for site in venv.glob("lib/python*/site-packages"):
            (site / "agent-tools.pth").write_text(f"{shared_site_packages()}\n")
        exclude = root / ".git" / "info" / "exclude"
        if exclude.parent.is_dir():
            exclude.write_text(exclude.read_text() + "\n.venv/\n" if exclude.exists() else ".venv/\n")
    return venv


# --- What sessions install, kept for the next ones ----------------------------------------

INSTALLERS = {  # a command part that installs something, and which list it goes in
    "pip": re.compile(r"^(?:sudo\s+)?(?:\S*/)?(?:python3?\s+-m\s+pip|pip3?)\s+install\s+(?P<args>.+)$"),
    "apt": re.compile(r"^(?:sudo\s+(?:-\S+\s+)*)?(?:apt-get|apt)\s+(?:-\S+\s+)*install\s+(?P<args>.+)$"),
    "brew": re.compile(r"^brew\s+install\s+(?P<args>.+)$"),
}
TAKES_A_VALUE = {"-r", "--requirement", "-c", "--constraint", "-t", "--target", "-i", "--index-url", "--extra-index-url",
                 "-f", "--find-links", "-e", "--editable", "-o", "--option", "--prefix", "--root"}


def shared_site_packages() -> Path:
    """The shared environment every project .venv also reads; recorded pip packages are installed into it."""
    version = f"python{sys.version_info.major}.{sys.version_info.minor}"
    return AGENT_TOOLS / "venv" / "lib" / version / "site-packages"


def installs(command: str) -> dict[str, list[str]]:
    """The packages a command installs, by installer: pip install x y, apt-get install -y z, brew install --cask w.
    Files, folders, URLs and options are not packages, so they are left out."""
    found: dict[str, list[str]] = {}
    for part in command_parts(command):
        part = re.sub(r"^(?:\w+=\S*\s+)+", "", part.strip())  # DEBIAN_FRONTEND=noninteractive apt-get ...
        part = re.sub(r"\s+(?:\d?>|&>).*$", "", part)  # redirects; pandas>=2 has no space before >
        for kind, rx in INSTALLERS.items():
            if not (m := rx.match(part)):
                continue
            try:
                words = shlex.split(m["args"])
            except ValueError:
                continue
            names, skip = [], False
            for w in words:
                if skip or w in TAKES_A_VALUE:
                    skip = not skip and w in TAKES_A_VALUE
                    continue
                if not w.startswith("-") and not re.search(r"[/:]|^\.", w):
                    names.append(w)
            if names:
                found.setdefault(kind, []).extend(names)
    return found


def read_installed() -> dict[str, list[str]]:
    path = AGENT_TOOLS / "installed.json"
    try:
        data = json.loads(path.read_text())
        return {k: sorted(set(v)) for k, v in data.items() if k in INSTALLERS and isinstance(v, list)}
    except (OSError, ValueError):
        return {}


def record_installs(agent: "CodingAgent", command: str) -> None:
    """After an install succeeds, it goes on the shared list, so later sessions have it and their CLAUDE.md says so.
    On this machine recorded pip packages also go into the shared environment, inside the sandbox like any command;
    a cloud session installs the list when it starts."""
    found = installs(command)
    known = read_installed()
    new = {k: [n for n in names if n not in known.get(k, [])] for k, names in found.items()}
    new = {k: v for k, v in new.items() if v}
    if not new:
        return
    AGENT_TOOLS.mkdir(parents=True, exist_ok=True)
    merged = {k: sorted(set(known.get(k, [])) | set(new.get(k, []))) for k in INSTALLERS}
    (AGENT_TOOLS / "installed.json").write_text(json.dumps({k: v for k, v in merged.items() if v}, indent=2) + "\n")
    shared = ""
    if new.get("pip") and isinstance(SANDBOX, Sandbox):
        venv = AGENT_TOOLS / "venv"
        if not (venv / "bin" / "python").exists():
            subprocess.run([sys.executable, "-m", "venv", str(venv)], capture_output=True, check=True, timeout=120)
        code, out = SANDBOX.run(f"{shlex.quote(str(venv / 'bin' / 'pip'))} install -q {shlex.join(new['pip'])}",
                                agent.ws.root, 600)
        shared = "" if code == 0 else f" (not added to the shared environment: {out.strip()[-200:]})"
    agent.emit({"type": "installed", "packages": new, "note": shared})


def installed_section() -> str:
    """For a new session's CLAUDE.md: what earlier sessions installed, so the agent uses it rather than reinstalls."""
    known = read_installed()
    if not known:
        return ""
    names = {"pip": "Python packages", "apt": "System packages (apt)", "brew": "Programs on this machine (brew)"}
    lines = "\n".join(f"- {names[k]}: {', '.join(v)}" for k, v in known.items())
    return ("\n\n## Installed by earlier sessions\n\nRecorded by the harness when an install succeeded, so they are already "
            f"here; use them without installing again.\n\n{lines}\n")


def find_chrome() -> str | None:
    """LLM_LAB_CHROME, or Chrome or a Chromium-based browser in the usual places."""
    return ENV.chrome_path or next((p for p in CHROME_PATHS if Path(p).is_file()), None) or next(
        (found for name in CHROME_NAMES if (found := shutil.which(name))), None)


def chrome_screenshot(url: str, width: int, height: int) -> tuple[bytes, list[str]]:
    """The top of a page as a PNG, from Chrome's own --screenshot, and what the page wrote to its console.
    Chrome prints console messages to stderr when logging is on, so no DevTools connection is needed."""
    chrome = find_chrome()
    if not chrome:
        raise ToolError("No Chrome or Chromium was found on this machine (set LLM_LAB_CHROME), so there is no screenshot.")
    with tempfile.TemporaryDirectory(prefix="coding-agent-chrome-") as tmp:
        shot = Path(tmp) / "shot.png"
        try:
            proc = subprocess.run(
                [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                 "--no-default-browser-check", "--disable-extensions", f"--user-data-dir={tmp}/profile",
                 f"--window-size={width},{height}", "--virtual-time-budget=1500",  # lets scripts and timers run
                 "--enable-logging=stderr", "--v=0", f"--screenshot={shot}", url],
                capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            raise ToolError("Chrome took more than 60 s to render the page.")
        if not shot.exists():
            raise ToolError("Chrome did not produce a screenshot.")
        console = [m.group(1)[:300] for m in re.finditer(r'CONSOLE[^\]]*\] "(.*)", source:', proc.stderr)]
        return shot.read_bytes(), console[:20]


def screenshot(args: dict, agent: "CodingAgent", ctx: Context, call_id: str) -> list[dict]:
    p = agent.ws.path(args["path"])
    rel = agent.ws.rel(p)
    if p.suffix.lower() not in PAGES:
        raise ToolError(f"screenshot renders {', '.join(PAGES)} files. To look at an image, use read_file.")
    if not p.is_file():
        raise ToolError(f"{rel} does not exist.")
    width = min(max(int(args.get("width") or 1000), 400), 1600)
    height = min(max(int(args.get("height") or 800), 300), 2000)
    try:
        if contained(agent) and isinstance(SANDBOX, SessionPool):  # in the cloud, Chromium is in the session
            png, console = SANDBOX.screenshot(agent.ws.root, rel, width, height)
        else:
            png, console = agent.screenshot(p.as_uri(), width, height)
    except (OSError, RuntimeError, TimeoutError) as exc:
        raise ToolError(f"The screenshot failed: {exc}")
    shown = image_result(f"{rel}, top of the page", png, "image/png")  # the image's size is the window's
    shown[0]["text"] += ("\nConsole:\n" + "\n".join(console)) if console else "\nNothing in the console."
    return shown


def todo_write(args: dict, agent: "CodingAgent", ctx: Context, call_id: str) -> str:
    todos = [{"content": str(t.get("content", ""))[:200], "status": t.get("status", "pending")} for t in args["todos"]]
    if any(t["status"] not in ("pending", "in_progress", "completed") for t in todos):
        raise ToolError("status must be pending, in_progress or completed.")
    if sum(t["status"] == "in_progress" for t in todos) > 1:
        raise ToolError("Keep one item in progress at a time.")
    agent.todos = todos
    agent.emit({"type": "todos", "todos": todos})
    return "To-do list updated. Keep it current as you work."


def explore(args: dict, agent: "CodingAgent", ctx: Context, call_id: str) -> str:
    return agent.loop(EXPLORE_PROMPT, [{"role": "user", "content": args["task"]}], depth=1, who="explore",
                      max_turns=8)


def tool(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {"name": name, "description": description,
            "input_schema": {"type": "object", "properties": properties, "required": required}}


S, I = {"type": "string"}, {"type": "integer"}
TOOLS: dict[str, dict] = {
    "read_file": tool("read_file", "Read a text file, with line numbers. Up to 400 lines at a time; use offset for more. "
                      "A folder lists its files. A PNG, JPEG, GIF or WebP comes back as the image, so you can see it.",
                      {"path": S, "offset": I, "limit": I}, ["path"]),
    "write_file": tool("write_file", "Create a file, or replace one you have read. Prefer edit_file for changes.",
                       {"path": S, "content": S}, ["path", "content"]),
    "edit_file": tool("edit_file", "Replace old_string with new_string in a file you have read. old_string must match "
                      "the file exactly (without line numbers) and appear once, unless replace_all is true.",
                      {"path": S, "old_string": S, "new_string": S, "replace_all": {"type": "boolean"}},
                      ["path", "old_string", "new_string"]),
    "glob": tool("glob", "Files whose path matches a pattern, such as **/*.py or tests/test_*.py.", {"pattern": S}, ["pattern"]),
    "grep": tool("grep", "Lines matching a regular expression, as path:line: text. path narrows to a folder or file; "
                 "glob narrows by file name, such as *.py.", {"pattern": S, "path": S, "glob": S}, ["pattern"]),
    "bash": tool("bash", "Run a shell command in the project folder, such as the tests, or a script you write when no "
                 "tool does what you need. Times out after 60 s by default (timeout, at most 300). Some commands are "
                 "refused or need a person's approval. In auto mode commands run in a sandbox; set outside_sandbox "
                 "only to install a program on the machine (such as brew install), which always asks the person.",
                 {"command": S, "timeout": I, "outside_sandbox": {"type": "boolean"}}, ["command"]),
    "screenshot": tool("screenshot", "Render an .html or .svg file from the project in headless Chrome and see it, with "
                       "anything the page wrote to its console. Use it to check what only shows by eye: layout, charts, "
                       "text cut off or overlapping. It shows the top of the page in a width × height window (default "
                       "1000 × 800); make height larger to see more of a long page.",
                       {"path": S, "width": I, "height": I}, ["path"]),
    "todo_write": tool("todo_write", "Replace the to-do list. Use it for work with three or more steps: add the steps, "
                       "mark one in_progress before starting it and completed as soon as it is done.",
                       {"todos": {"type": "array", "items": {"type": "object", "properties": {
                           "content": S, "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}},
                           "required": ["content", "status"]}}}, ["todos"]),
    "explore": tool("explore", "Hand a reading task to a sub-agent with its own empty context and only read_file, glob "
                    "and grep. It reports back in a few lines; its reads do not count as yours. Use it for questions "
                    "across many files.", {"task": S}, ["task"]),
}
RUN: dict[str, Callable] = {"read_file": read_file, "glob": glob_files, "grep": grep, "bash": bash,
                            "screenshot": screenshot, "todo_write": todo_write, "explore": explore}
PREPARE: dict[str, Callable] = {"write_file": prepare_write, "edit_file": prepare_edit}
READ_ONLY = {"read_file", "glob", "grep"}  # all the explore agent has
EDITS = set(PREPARE)


# --- Permissions ---------------------------------------------------------------

MODES = ["default", "accept_edits", "plan", "bypass", "auto"]
# Rules match each part of a command (split at &&, ||, ; and |). Deny applies in every mode, bypass included.
# Auto mode in a sandbox needs fewer: the sandbox already stops writes outside the project and reads of secrets, so
# pip, curl and rm are safe there. What is left reaches out of the sandbox: publishing code, other machines, root.
AUTO_DENY = ["sudo *", "ssh *", "scp *", "git push*"]  # in a cloud session sudo stays inside it, so it is allowed there
DENY = ["rm -rf*", "rm -r *", "sudo *", "curl *", "wget *", "ssh *", "scp *", "git push*", "git reset --hard*",
        "chmod *", "mv /*", "cp /*", "*/etc/*", "*~/*", "pip install*", "python -m pip*"]
READS = ["ls*", "cat *", "head *", "tail *", "wc *", "grep *", "sed -n *", "nl *", "pwd", "git status*", "git diff*", "git log*", "find . *", "tree*"]
ALLOW = [*READS, "python -m unittest*", "python3 -m unittest*", "python -m pytest*", "python -m py_compile *",
         "python -c *", "echo *"]
NEEDS_A_PERSON = ("`", "$(", ">", "<")  # substitution and redirects are never allowed without asking


def command_parts(command: str) -> list[str]:
    return [p.strip() for p in re.split(r"&&|\|\||;|\|", command) if p.strip()]


def permission(name: str, args: dict, mode: str) -> tuple[str, str]:
    """('allow' | 'ask' | 'deny', reason) for one tool call in one mode."""
    if name in READ_ONLY or name in ("screenshot", "todo_write", "explore"):
        return "allow", "reading"
    if name in EDITS:
        if mode == "plan":
            return "deny", "plan mode: describe the change instead of making it"
        return ("allow", f"{mode} mode") if mode in ("accept_edits", "bypass", "auto") else ("ask", "edits need approval")
    command = args.get("command", "").replace("2>&1", "")  # joining stderr to stdout writes nothing
    parts = command_parts(command)
    sandboxed = mode == "auto" and SANDBOX is not None
    if sandboxed and args.get("outside_sandbox"):
        if SANDBOX.kind == "sessions":
            return "deny", ("a cloud session has no outside: install inside it with apt-get install -y ..., or add "
                            "the program to the session image")
        if rule := next((r for p in parts for r in DENY if fnmatch.fnmatchcase(p, r) and r != "pip install*"), None):
            return "deny", f"deny rule {rule}"
        return "ask", "runs outside the sandbox, on this machine"
    rules = DENY if not sandboxed else [r for r in AUTO_DENY if not (r == "sudo *" and SANDBOX.kind == "sessions")]
    for part in parts:
        if rule := next((r for r in rules if fnmatch.fnmatchcase(part, r)), None):
            return "deny", f"deny rule {rule}"
    if mode == "plan":
        ok = parts and all(any(fnmatch.fnmatchcase(p, r) for r in READS) for p in parts) and not any(
            s in command for s in NEEDS_A_PERSON)
        return ("allow", "plan mode: read-only command") if ok else ("deny", "plan mode: only read-only commands")
    if mode in ("bypass", "auto"):  # auto without a sandbox keeps the full deny list, as bypass does
        return "allow", f"auto mode, in the {SANDBOX.kind} sandbox" if sandboxed else f"{mode} mode"
    if any(s in command for s in NEEDS_A_PERSON):
        return "ask", "redirects and substitutions need approval"
    if parts and all(any(fnmatch.fnmatchcase(p, r) for r in ALLOW) for p in parts):
        return "allow", "allow list"
    return "ask", "not on the allow list"


# --- Hooks ---------------------------------------------------------------------

def protect_files(agent: "CodingAgent", name: str, args: dict) -> str | None:
    """PreToolUse: secrets and git history are off limits, whatever the mode."""
    if name in EDITS and re.search(r"(^|/)(\.env|\.git)(/|$)", args.get("path", "")):
        return f"{args['path']} is protected"
    if name in EDITS and re.match(r"(\./)?inputs/", args.get("path", "")) and (agent.ws.root / "inputs").is_dir():
        return "inputs/ holds the person's own files; write to outputs/ instead"
    if name == "bash" and re.search(r"(^|[\s/])\.env\b", args.get("command", "")):
        return "commands may not touch .env"
    return None


def check_python(agent: "CodingAgent", name: str, args: dict, output: str) -> str:
    """PostToolUse: after Python is edited, compile it, so a syntax error comes back at once."""
    path = args.get("path", "")
    if name in EDITS and path.endswith(".py"):
        try:
            compile(agent.ws.path(path).read_text(encoding="utf-8"), path, "exec")
        except SyntaxError as exc:
            return output + f"\n\nSyntax check failed (hook): {exc.msg} at line {exc.lineno}."
    return output


TEST_COMMAND = "python -m unittest -q"  # the project's tests, as its CLAUDE.md says to run them
MAX_STOP_CHECKS = 3  # times a request can be sent back to work before the harness lets it finish anyway


def tests_pass(agent: "CodingAgent") -> str | None:
    """Stop: an agent that changed files is not done until the tests pass. Without this, "done" means only that the
    model stopped calling tools. Run by the harness, like any hook, so it needs no permission."""
    if agent.ws.fingerprint() == agent.started_with:
        return None  # nothing changed: a question, a plan, or every edit refused
    if not any(fnmatch.fnmatch(PurePosixPath(f).name, "test_*.py") for f in agent.ws.files()):
        return None  # a project without tests: nothing to check against
    try:
        out = bash({"command": TEST_COMMAND, "timeout": 120}, agent, agent.ctx, "stop-check")
    except ToolError as exc:
        out = f"exit code -1\n{exc}"
    passed = not out.startswith("exit code")
    agent.emit({"type": "stop_check", "passed": passed, "command": TEST_COMMAND, "output": out[-1500:]})
    if passed:
        return None
    return (f"You changed files, and `{TEST_COMMAND}` fails:\n{out[-1500:]}\nYou are not finished. Carry on until it "
            "passes. If it cannot pass, say exactly why.")


HOOKS = {"PreToolUse": [protect_files], "PostToolUse": [check_python], "Stop": [tests_pass]}


# --- Prompts -----------------------------------------------------------------------

SYSTEM = """You are a coding agent working in a project folder. You change the code with your tools; you never ask
the user to make a change for you. The person watches each step as it happens.

- Before each step, say in one short sentence what you are about to do and why; after a result that changes your
  plan, say what you learnt. Plain words, no headings.

- Read a file before you change it. edit_file replaces one exact, unique string: copy it from what you read,
  without the line numbers, and keep each edit small.
- Find code with grep and glob. For a question across many files, use explore.
- For work with three or more steps, keep a to-do list with todo_write and update it as you go.
- After changing code, run the tests (the project instructions say how). Finish when they pass, or say why not.
- What can only be judged by eye (a page, a chart) you check with screenshot after each change, and fix what you see.
- If no tool does what you need, use bash: write a small script, or use a program that is installed.
- If a call is denied, do not try another way round it. Say what you wanted to do and why.
- When you are done, reply with a short summary of what you changed and why, and no tool calls."""

EXPLORE_PROMPT = """You are a read-only explorer in a project folder. Answer the task with read_file, glob and grep,
then reply in at most eight lines: what you found, with file paths and line numbers. You cannot change anything."""

PLAN_NOTE = ("<system-reminder>Plan mode is on. You may read and search, but not change files or run commands "
             "that change anything. Finish with a plan: which files to change, how, and how to test it."
             "</system-reminder>")
MODE_NOTE = "<system-reminder>The permission mode is now {mode}.</system-reminder>"
AUTO_NOTE = ("<system-reminder>Auto mode: nobody is watching and nothing needs approval, so do not stop to ask; carry "
             "the task through to the end. If you lack a tool, a package or a program, get it: write a script, "
             "`pip install` into the project's .venv (first on the PATH; downloads are cached for later sessions), "
             "or put a downloaded program in {tools}/bin, which is on the PATH for every session. Commands run in a "
             "sandbox: they can write only in the project folder and that tools folder, and cannot read secrets. "
             "{install} git push and ssh are refused.</system-reminder>")
AUTO_INSTALL = {
    "sessions": "This is a Linux container of your own, and you may install anything: `apt-get install -y ...` works "
                "as it is (it runs as root for you); give it a timeout of 600.",
    "local": "To install a program on the machine itself (for example `brew install --cask libreoffice`), run bash "
             "with outside_sandbox: it asks the person first, and the program stays installed for every session. "
             "If they say no, carry on without it and say what you could not do.",
}


def project_memory(ws: Workspace) -> str:
    """CLAUDE.md, and a list of the files, for the system prompt. Read once per session."""
    p = ws.root / "CLAUDE.md"
    memory = f"\n\n<project_instructions file=\"CLAUDE.md\">\n{p.read_text(encoding='utf-8').strip()}\n</project_instructions>" \
        if p.exists() else ""
    files = ws.files()
    return memory + f"\n\n<files count=\"{len(files)}\">\n" + "\n".join(files[:80]) + "\n</files>"


# --- GPT through the same harness ----------------------------------------------------
#
# The harness keeps the conversation in Claude's message format. For a GPT deployment (Azure OpenAI, signed in with
# your Azure login), each call translates it to Chat Completions and the reply back, so everything else (tools,
# permissions, sandbox, clearing, the Stop hook, the page) is the same for both. Three things differ on the wire:
#   tools       input_schema becomes a function's parameters; tool_use blocks become tool_calls
#   results     tool_result blocks become role "tool" messages, which carry text only, so the images a tool returned
#               (a screenshot, a slide) follow in a user message
#   caching     GPT caches a long prompt prefix by itself, so Claude's cache_control markers are dropped

@dataclass
class Block:
    """A reply block in the shape the harness reads from Claude: text, or a tool_use with id, name and input."""
    type: str
    text: str | None = None
    id: str | None = None
    name: str | None = None
    input: dict | None = None

    def model_dump(self, exclude_none: bool = True) -> dict:
        return {k: v for k, v in vars(self).items() if v is not None or not exclude_none}


@dataclass
class Reply:
    content: list[Block]
    stop_reason: str
    usage: object
    model: str


STOP_REASONS = {"tool_calls": "tool_use", "stop": "end_turn", "length": "max_tokens", "content_filter": "refusal"}
GPT_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}


def is_gpt(model: str) -> bool:
    return model.startswith("gpt-")


def make_gpt_client():
    """An OpenAI client for the lab's Azure OpenAI endpoint, with an Entra token from your Azure login (no keys)."""
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider
    from openai import OpenAI
    if not ENV.azure_openai_endpoint:
        raise StopRun("AZURE_OPENAI_ENDPOINT is not set, so there is no GPT deployment to call")
    token = get_bearer_token_provider(DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default")
    return OpenAI(base_url=f"{ENV.azure_openai_endpoint.rstrip('/')}/openai/v1/", api_key=token)


def to_chat(system: str, tools: list[dict], messages: list[dict]) -> tuple[list[dict], list[dict]]:
    """The conversation and tools as Chat Completions wants them."""
    out: list[dict] = [{"role": "system", "content": system}]
    for m in messages:
        content = m["content"]
        if isinstance(content, str):
            out.append({"role": m["role"], "content": content})
        elif m["role"] == "assistant":
            text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
            calls = [{"id": b["id"], "type": "function",
                      "function": {"name": b["name"], "arguments": json.dumps(b.get("input") or {})}}
                     for b in content if b.get("type") == "tool_use"]
            out.append({"role": "assistant", "content": text or None, **({"tool_calls": calls} if calls else {})})
        else:
            parts, images = [], []
            for b in content:
                if b.get("type") == "tool_result":
                    c = b.get("content")
                    blocks = c if isinstance(c, list) else [{"type": "text", "text": str(c)}]
                    out.append({"role": "tool", "tool_call_id": b["tool_use_id"],
                                "content": "\n".join(x["text"] for x in blocks if x.get("type") == "text") or "(no text)"})
                    images += [x["source"] for x in blocks if x.get("type") == "image"]
                elif b.get("type") == "text":
                    parts.append({"type": "text", "text": b["text"]})
            if images:  # tool messages carry text only; the pictures come straight after them
                parts = [{"type": "text", "text": "The images returned by the tool calls above, in order:"},
                         *({"type": "image_url", "image_url": {"url": f"data:{i['media_type']};base64,{i['data']}"}}
                           for i in images), *parts]
            if parts:
                out.append({"role": "user", "content": parts})
    functions = [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                   "parameters": t["input_schema"]}} for t in tools]
    return out, functions


def from_chat(r, model: str) -> Reply:
    """A Chat Completions reply as the blocks, stop reason and usage the harness reads."""
    choice = r.choices[0]
    msg = choice.message
    blocks = [Block("text", text=msg.content)] if msg.content else []
    for call in msg.tool_calls or []:
        try:
            args = json.loads(call.function.arguments or "{}")
        except ValueError:
            args = {"_unreadable_arguments": call.function.arguments}  # the tool then reports the missing field
        blocks.append(Block("tool_use", id=call.id, name=call.function.name, input=args if isinstance(args, dict) else {}))
    stop = "refusal" if getattr(msg, "refusal", None) else STOP_REASONS.get(choice.finish_reason, "end_turn")
    if blocks and any(b.type == "tool_use" for b in blocks):
        stop = "tool_use"
    cached = getattr(getattr(r.usage, "prompt_tokens_details", None), "cached_tokens", 0) or 0
    usage = SimpleNamespace(input_tokens=r.usage.prompt_tokens - cached, cache_read_input_tokens=cached,
                            cache_creation_input_tokens=0, output_tokens=r.usage.completion_tokens)
    return Reply(blocks, stop, usage, model)


# --- The agent -----------------------------------------------------------------------

def print_event(e: dict) -> None:
    """Shows one event in the terminal. The lab backend streams the same events to the page instead."""
    pad = "    " * e.get("depth", 0)
    kind = e["type"]
    if kind == "text":
        print(f"\n{pad}{e['who']}: {e['text']}\n", flush=True)
    elif kind == "tool_use":
        print(f"{pad}→ {e['name']} {json.dumps(e['input'])[:160]}", flush=True)
    elif kind == "diff":
        print("".join(f"{pad}    {line}\n" for line in e["diff"].splitlines()[:40]), end="", flush=True)
    elif kind == "result":
        first = e["content"].splitlines()[0] if e["content"] else ""
        seen = f" [+ {len(e['images'])} image{'s' if len(e['images']) > 1 else ''} sent to Claude]" if e.get("images") else ""
        print(f"{pad}  {'✗' if e['is_error'] else '←'} {first[:140]}{seen}", flush=True)
    elif kind == "todos":
        print(pad + "  to-do: " + " · ".join(f"[{'x' if t['status'] == 'completed' else '>' if t['status'] == 'in_progress' else ' '}] "
                                          f"{t['content']}" for t in e["todos"]), flush=True)
    elif kind == "cleared":
        print(f"{pad}⇊ cleared {e['count']} old tool results ({e['tokens']:,} input tokens)", flush=True)
    elif kind == "installed":
        print(f"{pad}+ recorded for later sessions: " + "; ".join(f"{k} {' '.join(v)}" for k, v in e["packages"].items())
              + e.get("note", ""), flush=True)
    elif kind == "stop_check":
        print(f"{pad}■ stop check: {e['command']} {'passes, so the agent may finish' if e['passed'] else 'fails, so the agent carries on'}", flush=True)
    elif kind == "agent_start":
        print(f"{pad}┌ explore starts with an empty context: {e['task']}", flush=True)
    elif kind == "agent_end":
        print(f"{pad}└ explore reports back", flush=True)


class CodingAgent:
    """One session in one project folder. ask() can be called again: the conversation carries on."""

    def __init__(self, client, model: str, folder: Path, *, mode: str = "default", effort: str = "low",
                 budget: float = 0.5, max_turns: int = 30, clear_at: int = 40_000,
                 emit: Callable[[dict], None] = print_event, approve: Callable | None = None,
                 on_response: Callable | None = None, screenshot: Callable | None = None,
                 gpt_client=None) -> None:
        self.client, self.model, self.effort = client, model, effort
        self.screenshot = screenshot or chrome_screenshot  # (url, width, height) -> (PNG, console lines)
        self.gpt_client = gpt_client  # for a gpt-* model: an OpenAI client, made from settings when first needed
        self.ws = Workspace(folder)
        self.mode, self.budget, self.max_turns, self.clear_at = mode, budget, max_turns, clear_at
        self._emit, self._approve, self.on_response = emit, approve, on_response
        self.cancelled = threading.Event()
        self.messages: list[dict] = []
        self.ctx = Context()  # the main agent's reads
        self.todos: list[dict] = []
        self.notes: list[str] = []  # things the agent should hear before the next request, such as an undo
        self.system = SYSTEM + project_memory(self.ws)
        self.sent_mode = mode
        self.spent, self.turns, self.tool_calls = 0.0, 0, 0
        self.started_with, self.stop_checks = self.ws.fingerprint(), 0  # for the Stop hook, reset by each ask()
        self.lock = threading.Lock()

    def emit(self, event: dict) -> None:
        with self.lock:
            self._emit(event)

    def ask(self, prompt: str) -> str:
        """Runs one request to completion and returns Claude's final answer."""
        self.cancelled.clear()
        self.started_with, self.stop_checks = self.ws.fingerprint(), 0
        where = "sessions" if SANDBOX and SANDBOX.kind == "sessions" else "local"
        auto_note = AUTO_NOTE.format(tools="/work/tools" if where == "sessions" else AGENT_TOOLS,
                                     install=AUTO_INSTALL[where]) if contained(self) else ""
        notes = [*self.notes, *([PLAN_NOTE] if self.mode == "plan" else [auto_note] if contained(self) else
                                 [MODE_NOTE.format(mode=self.mode)] if self.mode != self.sent_mode else [])]
        self.notes, self.sent_mode = [], self.mode
        self.messages.append({"role": "user", "content": [{"type": "text", "text": t} for t in [*notes, prompt]]})
        # Nobody is watching in auto mode, so a long task gets room to finish; the spending budget still stops it.
        turns = max(self.max_turns, 60) if contained(self) else self.max_turns
        return self.loop(self.system, self.messages, depth=0, who="agent", max_turns=turns)

    def undo(self) -> Checkpoint | None:
        """Puts back the last file change, and tells the agent at its next request, as Claude Code's rewind does."""
        cp = self.ws.undo()
        if cp:
            self.notes.append(f"<system-reminder>The person undid your last change to {cp.path} ({cp.tool}). "
                              "Read it again before changing it.</system-reminder>")
        return cp

    def check_running(self) -> None:
        if self.cancelled.is_set():
            raise StopRun("stopped by the person")
        if self.spent >= self.budget:
            raise StopRun(f"the estimated spend ${self.spent:.3f} reached the ${self.budget:.2f} budget")

    def loop(self, system: str, messages: list[dict], *, depth: int, who: str, max_turns: int) -> str:
        """The agent loop, for the main agent and the explorer alike: call, run the tools, send results, repeat."""
        ctx = self.ctx if depth == 0 else Context()
        tools = list(TOOLS.values()) if depth == 0 else [TOOLS[n] for n in READ_ONLY]
        tools = [*tools[:-1], {**tools[-1], "cache_control": {"type": "ephemeral"}}]
        if depth:
            self.emit({"type": "agent_start", "who": who, "depth": depth, "task": messages[0]["content"]})
        for _ in range(max_turns):
            self.check_running()
            for m in messages:  # one moving cache breakpoint: the end of the conversation so far
                for b in m["content"] if isinstance(m["content"], list) else []:
                    if isinstance(b, dict):
                        b.pop("cache_control", None)
            last = messages[-1]["content"]
            if isinstance(last, list) and isinstance(last[-1], dict):
                last[-1]["cache_control"] = {"type": "ephemeral"}
            resp = self.complete(system, tools, messages)
            cost = cost_usd(resp.usage, self.model) or 0.0
            self.spent += cost
            self.turns += depth == 0
            if self.on_response:
                self.on_response(resp)
            messages.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in resp.content]})
            ensure_answered(resp)
            u = resp.usage
            self.emit({"type": "turn", "who": who, "depth": depth, "input_tokens": u.input_tokens,
                       "cache_read": getattr(u, "cache_read_input_tokens", 0) or 0,
                       "cache_write": getattr(u, "cache_creation_input_tokens", 0) or 0,
                       "output_tokens": u.output_tokens, "cost": round(cost, 6), "spent": round(self.spent, 6)})
            if text_of(resp).strip():
                self.emit({"type": "text", "who": who, "depth": depth, "text": text_of(resp).strip()})
            calls = [b for b in resp.content if b.type == "tool_use"]
            if resp.stop_reason != "tool_use" or not calls:
                if depth == 0 and self.stop_checks < MAX_STOP_CHECKS and \
                        (reason := next((r for hook in HOOKS["Stop"] if (r := hook(self))), None)):
                    self.stop_checks += 1  # not done yet: the hook's reason goes back as the next message
                    messages.append({"role": "user", "content": [
                        {"type": "text", "text": f"<system-reminder>Stop hook: {reason}</system-reminder>"}]})
                    continue
                if depth:
                    self.emit({"type": "agent_end", "who": who, "depth": depth})
                return text_of(resp).strip()
            results: list[dict] = []
            try:
                for block in calls:
                    results.append(self.call(block, ctx, depth, who))
            except StopRun:
                # Every tool_use needs a result, or the conversation cannot carry on after the stop.
                done = {r["tool_use_id"] for r in results}
                results += [{"type": "tool_result", "tool_use_id": b.id, "content": "Interrupted by the person.",
                             "is_error": True} for b in calls if b.id not in done]
                messages.append({"role": "user", "content": results})
                raise
            messages.append({"role": "user", "content": results})
            total = u.input_tokens + (getattr(u, "cache_read_input_tokens", 0) or 0) + (getattr(u, "cache_creation_input_tokens", 0) or 0)
            if depth == 0 and self.clear_at and total > self.clear_at:
                self.clear_old_results(messages, total)
        if depth:
            raise ToolError(f"explore stopped after {max_turns} turns without finishing.")
        raise StopRun(f"reached the limit of {max_turns} turns")

    def complete(self, system: str, tools: list[dict], messages: list[dict]):
        """One model call: Claude through the Messages API, or a GPT deployment through Chat Completions."""
        if not is_gpt(self.model):
            return create(self.client, model=self.model, max_tokens=8000, tools=tools, messages=messages,
                          system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                          output_config={"effort": self.effort})
        if self.gpt_client is None:
            self.gpt_client = make_gpt_client()
        chat, functions = to_chat(system, tools, messages)
        extra = {"reasoning_effort": GPT_EFFORT.get(self.effort, "low")} if self.model.startswith("gpt-5") else {}
        r = self.gpt_client.chat.completions.create(model=self.model, messages=chat, tools=functions,
                                                    max_completion_tokens=8000, **extra)
        return from_chat(r, self.model)

    def clear_old_results(self, messages: list[dict], tokens: int, keep: int = 4) -> None:
        """Empties all but the last few tool results, at once. Files whose reads were cleared count as unread."""
        results = [b for m in messages if m["role"] == "user" and isinstance(m["content"], list)
                   for b in m["content"] if isinstance(b, dict) and b.get("type") == "tool_result"]
        old = [b for b in results[:-keep] if b.get("content") != CLEARED]
        for b in old:
            b["content"] = CLEARED
            if path := self.ctx.read_ids.pop(b["tool_use_id"], None):
                self.ctx.reads.pop(path, None)
        if old:
            self.emit({"type": "cleared", "count": len(old), "tokens": tokens})

    def call(self, block, ctx: Context, depth: int, who: str) -> dict:
        """One tool call: hooks, the change worked out, the permission check, the tool, hooks again, the result."""
        name, args = block.name, dict(block.input)
        self.emit({"type": "tool_use", "who": who, "depth": depth, "id": block.id, "name": name, "input": args})

        def result(content: str | list[dict], error: bool = False) -> dict:
            # A result is text, or a list of blocks when it carries an image; the page is sent the image too.
            content = capped(content) if isinstance(content, str) else content
            blocks = content if isinstance(content, list) else []
            shown = content if isinstance(content, str) else "\n".join(b["text"] for b in blocks if b["type"] == "text")
            images = [{"media_type": b["source"]["media_type"], "data": b["source"]["data"]}
                      for b in blocks if b["type"] == "image"]
            self.emit({"type": "result", "who": who, "depth": depth, "id": block.id, "name": name,
                       "content": shown[:4000], "is_error": error, **({"images": images} if images else {})})
            return {"type": "tool_result", "tool_use_id": block.id, "content": content, **({"is_error": True} if error else {})}

        self.check_running()
        allowed = TOOLS if depth == 0 else {n: TOOLS[n] for n in READ_ONLY}
        if name not in allowed:
            return result(f"There is no tool called {name} here.", error=True)
        for hook in HOOKS["PreToolUse"]:
            if reason := hook(self, name, args):
                return result(f"Blocked by a hook: {reason}.", error=True)
        try:
            change = PREPARE[name](args, self, ctx) if name in PREPARE else None
        except (ToolError, KeyError) as exc:
            return result(f"Error: {exc}", error=True)
        if change:  # the page shows the diff with the approval, before anything is written
            self.emit({"type": "diff", "who": who, "depth": depth, "id": block.id, "path": change.path,
                       "diff": unified(change.path, change.before, change.after)})
        decision, why = permission(name, args, self.mode)
        if decision == "ask":
            decision = "allow" if self._approve and self._approve(block, who, depth, why) else "deny"
            why = "a person decided" if decision == "allow" else "a person said no"
        if decision == "deny":
            self.check_running()
            return result(f"Permission denied ({why}).", error=True)
        self.tool_calls += 1
        try:
            if change:
                cp = self.ws.save(change.path, change.after, name)
                ctx.reads[change.path] = self.ws.path(change.path).stat().st_mtime  # its own write counts as read
                self.emit({"type": "checkpoint", "id": cp.id, "path": cp.path, "tool": name, "count": len(self.ws.checkpoints)})
                output = f"{change.path}: {change.note}."
            else:
                output = RUN[name](args, self, ctx, block.id)
        except (ToolError, KeyError) as exc:
            return result(f"Error: {exc}", error=True)
        for hook in HOOKS["PostToolUse"]:
            output = hook(self, name, args, output)
        return result(output)


def new_project(into: Path | None = None, template: Path = PROJECT) -> Path:
    """A fresh copy of a project: coding_project, or analysis_project for the person's own files. CLAUDE.example.md
    becomes CLAUDE.md there, where the agent reads it."""
    folder = into or Path(tempfile.mkdtemp(prefix="coding-agent-")) / "project"
    shutil.copytree(template, folder, ignore=shutil.ignore_patterns("__pycache__"), dirs_exist_ok=True)
    (folder / "CLAUDE.example.md").rename(folder / "CLAUDE.md")
    if section := installed_section():
        with (folder / "CLAUDE.md").open("a", encoding="utf-8") as f:
            f.write(section)
    git_init(folder)
    return folder


def git_init(folder: Path) -> None:
    """Makes the copy its own git repository with one commit, so git commands see the copy (and `git diff` shows
    the agent's changes), never a repository the folder happens to sit inside."""
    if shutil.which("git") is None:
        return
    git = ["git", "-c", "user.name=Coding agent lab", "-c", "user.email=lab@localhost", "-c", "commit.gpgsign=false"]
    for args in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "Starting point"]):
        subprocess.run([*git, *args], cwd=folder, capture_output=True, check=False)


WORKSPACES = {"practice": (PROJECT, ["fix", "feature", "plan", "cleanup", "page", "excel"]),
              "files": (FILES_PROJECT, ["analyse", "deck"])}  # template, and the tasks that fit it
TASKS = {
    "fix": "The tests are failing. Find out why and fix the code.",
    "feature": "Add a command-line report: `python -m ledger data/sample.csv` should print money out by category and "
               "the net amount by month. Add a test for it, and keep every test passing.",
    "plan": "Plan how to add monthly budgets per category: a limit for each category, and a warning when a month's "
            "spending passes it. Do not change any files.",
    "cleanup": "Clear out the project with `rm -rf data tests`, then force-push it with `git push --force origin main`.",
    "page": "Make report.html: a horizontal bar chart of money out by category in data/sample.csv, drawn with inline "
            "SVG and no libraries, each bar labelled with its category and amount. Then look at it with a screenshot "
            "and fix anything cut off, overlapping or hard to read.",
    "analyse": "Look at the files in inputs/ and work out what the data is. Write outputs/summary.md: what it shows, "
               "the key numbers and anything odd, with two or three charts saved as PNG in outputs/. Look at each "
               "chart before you describe it.",
    "deck": "Make outputs/summary.pptx from the files in inputs/: a title slide, a slide of key numbers, a slide for "
            "each of two or three charts, and one of things to look into. Render the slides to images and look at "
            "them before you finish.",
    "excel": "Export money out by category and the net amount by month from data/sample.csv to report.xlsx, a real "
             "Excel workbook with one sheet for each and a total row on the first. Then open it again in code to check "
             "the numbers.",
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("prompt", nargs="?", help="your own request, instead of a task")
    parser.add_argument("--task", choices=list(TASKS), help="a preset task: fix by default, analyse with --files")
    parser.add_argument("--mode", choices=MODES, default="default")
    parser.add_argument("--effort", default="low", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--budget", type=float, default=0.5, help="stop when the estimated spend reaches this many dollars")
    parser.add_argument("--clear-at", type=int, default=40_000, help="clear old tool results past this many input tokens")
    parser.add_argument("--folder", type=Path, help="work in this folder instead of a fresh copy of coding_project")
    parser.add_argument("--files", type=Path, nargs="+", help="work on these files: an empty workspace with them in "
                        "inputs/ (try analysis_samples/bakery-sales-2025.xlsx with --task analyse or deck)")
    parser.add_argument("--keep", action="store_true", help="keep the copy of the project afterwards")
    parser.add_argument("--yes", action="store_true", help="approve every prompt without asking")
    parser.add_argument("--export-installed", type=Path, metavar="DIR",
                        help="write what sessions installed to DIR/extra-requirements.txt and DIR/extra-apt.txt "
                             "(examples/coding-sandbox), so the next image has it from the start; then stop")
    model_argument(parser)
    args = parser.parse_args()
    if args.export_installed:
        known = read_installed()
        for name, kind in (("extra-requirements.txt", "pip"), ("extra-apt.txt", "apt")):
            (args.export_installed / name).write_text(
                f"# Recorded by the coding agent's sessions ({kind}); built into the image by the Dockerfile.\n"
                + "".join(f"{n}\n" for n in known.get(kind, [])))
        print(f"Wrote {sum(len(v) for k, v in known.items() if k != 'brew')} packages to {args.export_installed}")
        return

    def ask_in_terminal(block, who, depth, reason) -> bool:
        if args.yes:
            return True
        if not sys.stdin.isatty():
            return False  # nobody to ask, so the call is refused
        what = block.input.get("command") or block.input.get("path")
        return input(f"    Allow {block.name} {what}? ({reason}) [y/N] ").strip().lower() == "y"

    folder = args.folder or new_project(template=FILES_PROJECT if args.files else PROJECT)
    for f in args.files or []:
        shutil.copy2(f, folder / "inputs" / f.name)
    agent = CodingAgent(make_client(), args.model, folder, mode=args.mode, effort=args.effort, budget=args.budget,
                        clear_at=args.clear_at, approve=ask_in_terminal)
    prompt = args.prompt or TASKS[args.task or ("analyse" if args.files else "fix")]
    print(f"Project: {folder}\nMode: {args.mode}\nUser: {prompt}\n")
    try:
        answer, outcome = agent.ask(prompt), "done"
    except StopRun as exc:
        answer, outcome = None, f"stopped by the harness: {exc}"
    diff = agent.ws.diff()
    print(f"\nOutcome: {outcome}. {agent.turns} turns, {agent.tool_calls} tool calls, "
          f"{len(agent.ws.checkpoints)} checkpoints, about ${agent.spent:.4f}.")
    print(f"\nChanges:\n{diff}" if diff else "\nNo files changed.")
    if not args.folder and not args.keep:
        shutil.rmtree(folder.parent, ignore_errors=True)
    elif not args.folder:
        print(f"\nKept in {folder}")


if __name__ == "__main__":
    run(main)
