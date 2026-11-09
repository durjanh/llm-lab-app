"""The coding agent's shell, in a container of its own, away from the backend and its credentials.

It runs two ways with the same image and code. In a dynamic session pool (option A) each agent session gets its
own Hyper-V isolated container. In a container app on the Consumption plan (option B) every session shares one
container, each in its own folder. The `identifier` query parameter names the session either way.

The lab backend keeps the project: its checkpoints, diffs and file tools work on its own copy. For each shell command
it sends the project here as a .tar.gz, this server makes the session's project folder match it, runs the command,
and sends the project back. The project's .venv stays here, so `pip install` lasts while the session does.

    POST /run?identifier=<id>         {"command": "...", "timeout": 60, "archive": "<base64 .tar.gz>",
                                       "setup": {"pip": [], "apt": []}}
                                   -> {"returncode": 0, "output": "...", "timed_out": false, "archive": "..."}
      with "delta": true in the request, the archive holds only the files the command added or changed, and
      "deleted" lists those it removed, so a large unchanged file (a 12 MB deck) is not sent back every time;
      with "since" (the "sync" id of the last request this session ran), the archive holds only what changed since
      then and "removed" lists what was deleted, so it is not sent in every time either. 409 means start again with
      the whole project. GET /health says {"delta": 2} when the server takes both.
    POST /screenshot?identifier=<id>  {"path": "report.html", "width": 1000, "height": 800, "archive": "..."}
                                   -> {"png": "<base64>", "console": ["..."]}, from the image's Chromium
    GET  /health                      for probes

The agent may install system packages with `apt-get install` (run through sudo, for apt only): the container is its
own, so root inside it reaches nothing else. What earlier sessions installed (the harness's record, sent as `setup`)
is installed once per container into tools/, which every session's .venv also reads.

Requests are signed before they reach this server: by the pool (option A), or by Container Apps' built-in sign-in
(option B). The server has no sign-in of its own. Standard library only.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

WORK = Path(os.environ.get("WORK_DIR", "/work")).resolve()
KEEP = {".venv"}  # stays here, never sent either way
SKIP = {".venv", "__pycache__", "node_modules"}
MAX_ARCHIVE = 25 * 1024 * 1024
MAX_OUTPUT = 200_000
IDLE_S = 3600  # a session folder untouched this long is removed
LOCKS: dict[str, threading.Lock] = {}  # one command at a time per session; sessions run side by side
SETUP_LOCK = threading.Lock()


@dataclass(frozen=True)
class Space:
    """One agent session's folders."""
    root: Path

    @property
    def project(self) -> Path:
        return self.root / "project"

    @property
    def home(self) -> Path:
        return self.root / "home"

    @property
    def tmp(self) -> Path:
        return self.root / "tmp"


def tools() -> Path:
    """Shared by every session in this container: pip's cache, bin/ for downloaded programs, and a venv for what
    earlier sessions installed."""
    return WORK / "tools"


def space(identifier: str) -> Space:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", identifier):
        raise ValueError("identifier must be 1 to 64 letters, digits, - or _")
    s = Space(WORK / "sessions" / identifier)
    for d in (s.project, s.home, s.tmp, tools() / "bin"):
        d.mkdir(parents=True, exist_ok=True)
    (s.root / ".last").touch()
    return s


def forget_idle() -> None:
    """Removes session folders nobody has used for an hour. In a session pool the container goes first anyway."""
    for root in (WORK / "sessions").glob("*"):
        last = root / ".last"
        if last.exists() and time.time() - last.stat().st_mtime > IDLE_S and not LOCKS.get(root.name, threading.Lock()).locked():
            shutil.rmtree(root, ignore_errors=True)


def pack(root: Path) -> bytes:
    """The project as a .tar.gz: regular files and folders only, without .venv and caches."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = sorted(d for d in dirs if d not in SKIP and not os.path.islink(os.path.join(dirpath, d)))
            for name in [*dirs, *sorted(files)]:
                p = Path(dirpath) / name
                if p.is_symlink() or not (p.is_file() or p.is_dir()):
                    continue
                tar.add(p, arcname=p.relative_to(root).as_posix(), recursive=False)
    return buf.getvalue()


def unpack(root: Path, data: bytes) -> None:
    """Makes root match the archive: writes what differs, removes what is not in it. .venv is left alone."""
    files, folders = set(), set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            p = (root / m.name).resolve()
            if not (m.isfile() or m.isdir()) or not p.is_relative_to(root) or p == root or \
                    Path(m.name).parts[0] in KEEP:
                continue
            if m.isdir():
                folders.add(p)
                p.mkdir(parents=True, exist_ok=True)
                continue
            files.add(p)
            content = tar.extractfile(m).read()
            if p.is_dir():
                shutil.rmtree(p)
            if not p.exists() or p.read_bytes() != content:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(content)
                p.chmod((m.mode & 0o755) | 0o600)
    for dirpath, dirs, names in os.walk(root, topdown=False):
        here = Path(dirpath)
        if here != root and Path(os.path.relpath(here, root)).parts[0] in KEEP:
            continue
        for name in names:
            if (here / name) not in files:
                (here / name).unlink()
        if here != root and here not in folders and not any(here.iterdir()):
            here.rmdir()


def fingerprint(root: Path) -> dict[str, str]:
    """Each file pack would send, by path, with a hash of its content."""
    found = {}
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP and not os.path.islink(os.path.join(dirpath, d))]
        for name in files:
            p = Path(dirpath) / name
            if p.is_file() and not p.is_symlink():
                found[p.relative_to(root).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return found


def pack_changes(root: Path, before: dict[str, str]) -> tuple[bytes, list[str]]:
    """The files added or changed since `before`, as a .tar.gz, and the paths removed since then."""
    after = fingerprint(root)
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel, digest in sorted(after.items()):
            if before.get(rel) != digest:
                tar.add(root / rel, arcname=rel, recursive=False)
    return buf.getvalue(), sorted(set(before) - set(after))


def apply_changes(root: Path, data: bytes, deleted: list[str]) -> None:
    """The other end of pack_changes: writes the changed files and removes the deleted ones, leaving the rest."""
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            p = (root / m.name).resolve()
            if not m.isfile() or not p.is_relative_to(root) or Path(m.name).parts[0] in KEEP:
                continue
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(tar.extractfile(m).read())
            p.chmod((m.mode & 0o755) | 0o600)
    for rel in deleted:
        p = (root / rel).resolve()
        if p.is_relative_to(root) and p != root and Path(rel).parts[0] not in KEEP and p.is_file():
            p.unlink()


def make_venv(venv: Path) -> Path:
    """A venv that sees the image's own packages (pandas, python-pptx...) and the shared one, with pip on top."""
    if not (venv / "bin" / "python").exists():
        subprocess.run([sys.executable, "-m", "venv", "--system-site-packages", str(venv)], capture_output=True,
                       check=True, timeout=120)
        shared = tools() / "venv"
        if venv != shared:
            for site in venv.glob("lib/python*/site-packages"):
                (site / "agent-tools.pth").write_text(f"{shared / site.relative_to(venv)}\n")
    return venv


def set_up(packages: dict) -> None:
    """What earlier sessions installed and the harness recorded: installed once per container, into the shared
    venv and the system, so every session here has it. Failures are logged and left to the agent."""
    with SETUP_LOCK:
        record = tools() / "set-up.json"
        done = json.loads(record.read_text()) if record.exists() else {"pip": [], "apt": []}
        apt = [n for n in packages.get("apt", []) if re.fullmatch(r"[a-z0-9][a-z0-9+.\-]*", n) and n not in done["apt"]]
        pip = [n for n in packages.get("pip", []) if not n.startswith("-") and n not in done["pip"]]
        env = {"PATH": "/usr/bin:/bin", "HOME": str(tools()), "DEBIAN_FRONTEND": "noninteractive",
               "PIP_CACHE_DIR": str(tools() / "pip-cache")}
        steps = []
        if apt:
            steps += [(["sudo", "-n", "/usr/bin/apt-get", "update", "-qq"], None),
                      (["sudo", "-n", "/usr/bin/apt-get", "install", "-y", "-qq", "--no-install-recommends", *apt], "apt")]
        if pip:
            steps.append(([str(make_venv(tools() / "venv") / "bin" / "pip"), "install", "-q", *pip], "pip"))
        for step, kind in steps:
            proc = subprocess.run(step, capture_output=True, text=True, timeout=900, env=env)
            print(f"set up: {' '.join(step[:6])} -> {proc.returncode}", flush=True)
            if kind and proc.returncode == 0:
                done[kind] = sorted(set(done[kind]) | set(apt if kind == "apt" else pip))
        record.write_text(json.dumps(done))


def run(s: Space, command: str, timeout: int) -> tuple[int, str, bool]:
    venv = make_venv(s.project / ".venv")
    env = {"PATH": f"{venv / 'bin'}:{tools() / 'bin'}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
           "HOME": str(s.home), "TMPDIR": str(s.tmp), "PIP_CACHE_DIR": str(tools() / "pip-cache"),
           "VIRTUAL_ENV": str(venv), "MPLBACKEND": "Agg", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1",
           "GIT_CEILING_DIRECTORIES": str(s.root), "LANG": "C.UTF-8", "DEBIAN_FRONTEND": "noninteractive"}
    proc = subprocess.Popen(["/bin/bash", "-c", command], cwd=s.project, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, start_new_session=True)
    try:
        out, _ = proc.communicate(timeout=timeout)
        return proc.returncode, out.decode("utf-8", "replace")[-MAX_OUTPUT:], False
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)  # the command and anything it started
        out, _ = proc.communicate()
        return -9, out.decode("utf-8", "replace")[-MAX_OUTPUT:], True


def screenshot(s: Space, path: str, width: int, height: int) -> tuple[bytes, list[str]]:
    """The top of a project page, as the agent's screenshot tool sees it locally. Chromium's own sandbox needs
    privileges this container does not have; the container itself is the boundary, so it runs with --no-sandbox."""
    page = (s.project / path).resolve()
    if not page.is_relative_to(s.project) or page.suffix.lower() not in (".html", ".htm", ".svg") or not page.is_file():
        raise ValueError(f"{path} is not an .html or .svg file in the project")
    shot = s.tmp / "shot.png"
    shot.unlink(missing_ok=True)
    proc = subprocess.run(
        ["chromium", "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars",
         "--no-first-run", f"--user-data-dir={s.tmp / 'chrome'}", f"--window-size={width},{height}",
         "--virtual-time-budget=1500", "--enable-logging=stderr", "--v=0", f"--screenshot={shot}", page.as_uri()],
        capture_output=True, text=True, timeout=60, env={"HOME": str(s.home), "PATH": "/usr/bin:/bin"})
    if not shot.exists():
        raise OSError(f"Chromium did not produce a screenshot: {proc.stderr.strip()[-300:]}")
    console = [m.group(1)[:300] for m in re.finditer(r'CONSOLE[^\]]*\] "(.*)", source:', proc.stderr)][:20]
    return shot.read_bytes(), console


class Handler(BaseHTTPRequestHandler):
    def reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        self.reply(200, {"status": "ok", "delta": 2}) if urlsplit(self.path).path in ("/health", "/") else self.reply(404, {})

    def do_POST(self) -> None:  # noqa: N802
        url = urlsplit(self.path)
        if url.path not in ("/run", "/screenshot"):
            return self.reply(404, {"error": "POST /run or /screenshot"})
        size = int(self.headers.get("Content-Length") or 0)
        if size > MAX_ARCHIVE * 2:
            return self.reply(413, {"error": "The project is too large to send."})
        try:
            identifier = (parse_qs(url.query).get("identifier") or ["default"])[0]
            s = space(identifier)
            body = json.loads(self.rfile.read(size))
            timeout = max(1, min(int(body.get("timeout") or 60), 900))  # installing a program can take minutes
            forget_idle()
            with LOCKS.setdefault(identifier, threading.Lock()):
                synced = s.root / ".synced"  # the sync id of the last request this session ran
                if "since" in body:  # only what changed since then
                    if not synced.exists() or synced.read_text() != body["since"]:
                        return self.reply(409, {"error": "Out of step with this session: send the whole project."})
                    apply_changes(s.project, base64.b64decode(body["archive"]), body.get("removed") or [])
                else:
                    unpack(s.project, base64.b64decode(body["archive"]))
                synced.unlink(missing_ok=True)  # until this request has finished, nothing is in step
                before = fingerprint(s.project) if body.get("delta") else None  # what the caller has now
                set_up(body.get("setup") or {})
                if url.path == "/screenshot":
                    png, console = screenshot(s, str(body["path"]), int(body.get("width") or 1000),
                                              int(body.get("height") or 800))
                    if body.get("sync"):
                        synced.write_text(str(body["sync"]))
                    return self.reply(200, {"png": base64.b64encode(png).decode(), "console": console})
                code, output, timed_out = run(s, str(body["command"]), timeout)
                archive, deleted = pack_changes(s.project, before) if before is not None else (pack(s.project), None)
                if body.get("sync") and len(archive) <= MAX_ARCHIVE:
                    synced.write_text(str(body["sync"]))
        except (KeyError, ValueError, tarfile.TarError, OSError, subprocess.SubprocessError) as exc:
            return self.reply(400, {"error": f"{type(exc).__name__}: {exc}"})
        if len(archive) > MAX_ARCHIVE:
            return self.reply(413, {"error": "One command made more than 25 MB of new files to send back. Keep build "
                                             "output small, or delete files you no longer need."})
        self.reply(200, {"returncode": code, "output": output, "timed_out": timed_out,
                         "archive": base64.b64encode(archive).decode(),
                         **({"deleted": deleted} if deleted is not None else {})})

    def log_message(self, fmt: str, *args) -> None:  # one line per request to stdout, which Azure's logs keep
        print(f"{self.command} {urlsplit(self.path).path} {args[1] if len(args) > 1 else ''}", flush=True)


if __name__ == "__main__":
    # All interfaces in the container, where Azure reaches it; on your own machine set HOST=127.0.0.1,
    # or anyone on your network could run commands.
    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8080"))
    print(f"coding sandbox listening on {host}:{port}, working in {WORK}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
