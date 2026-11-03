"""The site builder: a conversation in which Claude writes a website into a folder on this server.

Claude works through five file tools confined to the site's folder; it runs no commands. Each file
streams to the page as Claude writes it, and the preview reloads when the file is saved. When Claude
has finished, the backend screenshots the site in headless Chrome at desktop and phone widths and
shows Claude the screenshots and any console errors, so it can fix what it sees, up to
REVIEW_ROUNDS times. Every site keeps its files and conversation on disk under sites/<id>/.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import shutil
import threading
import time
import uuid
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from jiter import from_json

from ..core.errors import ApiError
from ..gateways.browser import DESKTOP, PHONE, Screenshotter
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, cost_usd, describe_usage, text_of
from .runs import Run, RunStreamer
from .spend import SpendTracker, money

TEXT_TYPES = {
    ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
    ".json": "application/json", ".svg": "image/svg+xml", ".txt": "text/plain", ".md": "text/markdown",
    ".xml": "application/xml", ".webmanifest": "application/manifest+json",
}
MAX_SITE_FILES = 80
MAX_FILE_BYTES = 300_000
MAX_SITE_BYTES = 3_000_000
MAX_READ_CHARS = 100_000
MAX_PROMPT_CHARS = 4000
MAX_REQUESTS = 40  # requests to Claude in one turn, counting tool rounds and screenshot checks
MAX_TOKENS = 32000
REVIEW_ROUNDS = 2  # how often Claude is shown screenshots and fixes what it sees
SITE_ID = re.compile(r"^[0-9a-f]{12}$")

SYSTEM = """You build websites in a project folder. The user watches each file appear as you write it and sees the site in a live preview next to the conversation.
- Work only through the file tools. Paths are relative to the site's root, such as index.html, css/styles.css, js/app.js or data/products.json. The site opens at index.html. Link between files with relative paths, never paths starting with /.
- Write plain HTML, CSS and JavaScript that runs as it is: no build step, no npm packages and no frameworks, unless the user asks for one, in which case load it from a CDN.
- There is no server-side code. When the site needs an API, make a mock one: JSON files under data/ and a js/api.js whose async functions fetch them, so a real API can replace it later. Forms validate in the browser and show a confirmation; they send nothing anywhere.
- No image files are available, and you cannot make photos. Use CSS, inline SVG or SVG files you write, and do not link to images on other sites.
- Make every page responsive from 390 to 1440 pixels wide with no sideways scrolling on a phone, accessible (semantic HTML, labels, alt text, visible focus, readable contrast), and free of console errors.
- The preview shows index.html from the moment it is saved, and each file is saved as soon as you finish writing it. So for a new site write index.html first, then the CSS, then the JavaScript and data, so the user sees the page take shape.
- Keep CSS and JavaScript in their own files. Write each new file whole with write_file. For a small change to an existing file use edit_file, copying old_text exactly from the file; read_file first when you are not sure what it contains.
- After you finish, the backend takes screenshots of the site at 1280 and 390 pixels wide and shows them to you with any console errors, so you can fix what you see. You cannot open the site yourself.
- Every request is about this site. Never delete the site's files to start a different website, and never replace it with a site on another subject. If the user asks for a website that is clearly a different one, change no files: reply that each site has its own conversation, and that they should press New site and ask there.
- When you are done, reply briefly: what you built or changed, then anything you could not do."""

REVIEW = """Here are screenshots of the site after your changes: {desktop} at 1280 pixels wide, then {phone} at 390 pixels wide, each from the top of the page down.
{errors}
Check them as a careful designer and front-end developer would: layout, spacing and alignment, text that overflows or is cut off, anything that scrolls sideways on the phone, readability and contrast, missing or broken content, and whether the site does what the user asked.
{action}"""
FIX = """If everything is right, do not change any files, and reply with your final summary.
If anything is wrong, fix it with the file tools, then reply. You will be shown new screenshots."""
FIX_LAST = """This is the last check. If everything is right, do not change any files, and reply with your final summary.
If anything is wrong, fix it with the file tools, then reply with your final summary and what you changed."""


def tool(name: str, description: str, properties: dict) -> dict:
    """A file tool. write_file and edit_file stream their input, so the page can show code as it is written."""
    return {"name": name, "description": description,
            "input_schema": {"type": "object", "properties": properties, "required": list(properties),
                             "additionalProperties": False},
            **({"eager_input_streaming": True} if name in WRITERS else {})}


WRITERS = {"write_file": "content", "edit_file": "new_text"}  # tool -> the input that holds the code
PATH = {"type": "string", "description": "Relative to the site's root, such as css/styles.css."}
TOOLS = [
    tool("write_file", "Create a file, or replace one, with the complete content.",
         {"path": PATH, "content": {"type": "string", "description": "The whole file."}}),
    tool("edit_file", "Replace one exact piece of an existing file. old_text must appear exactly once.",
         {"path": PATH, "old_text": {"type": "string"}, "new_text": {"type": "string"}}),
    tool("read_file", "Read a file of the site.", {"path": PATH}),
    tool("list_files", "List the site's files with their sizes.", {}),
    tool("delete_file", "Delete a file of the site.", {"path": PATH}),
]


class FileProblem(Exception):
    """A tool call Claude can correct: it gets the message back as an error."""


class SiteFiles:
    """The site's folder. Every path is checked to stay inside it, with limits on file count and size."""

    def __init__(self, root: Path):
        self.root = root

    def resolve(self, path: Any) -> tuple[str, Path]:
        if not isinstance(path, str) or not path.strip():
            raise FileProblem("Give a path, such as index.html or css/styles.css.")
        clean = path.strip().removeprefix("./")
        parts = PurePosixPath(clean).parts
        if "\\" in clean or clean.startswith("/") or any(p in (".", "..") or p.startswith(".") for p in parts):
            raise FileProblem(f"{path!r} is not a path inside the site. Use a relative path such as css/styles.css.")
        if PurePosixPath(clean).suffix.lower() not in TEXT_TYPES:
            raise FileProblem(f"{path}: only {', '.join(sorted(TEXT_TYPES))} files can be written.")
        full = (self.root / clean).resolve()
        if self.root.resolve() not in full.parents:
            raise FileProblem(f"{path!r} is not a path inside the site.")
        return clean, full

    def write(self, path: Any, content: Any) -> str:
        if not isinstance(content, str):
            raise FileProblem("content must be the file's text.")
        rel, full = self.resolve(path)
        size = len(content.encode())
        if size > MAX_FILE_BYTES:
            raise FileProblem(f"{rel} would be {size:,} bytes; a file may be at most {MAX_FILE_BYTES:,}. Split it up.")
        files = self.listing()
        if not full.exists() and len(files) >= MAX_SITE_FILES:
            raise FileProblem(f"A site may have at most {MAX_SITE_FILES} files.")
        total = sum(f["size"] for f in files if f["path"] != rel) + size
        if total > MAX_SITE_BYTES:
            raise FileProblem(f"The site would be {total:,} bytes; it may be at most {MAX_SITE_BYTES:,}.")
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
        return f"Wrote {rel} ({size:,} bytes)."

    def edit(self, path: Any, old_text: Any, new_text: Any) -> str:
        rel, full = self.resolve(path)
        if not full.is_file():
            raise FileProblem(f"{rel} does not exist. Create it with write_file.")
        if not isinstance(old_text, str) or not old_text or not isinstance(new_text, str):
            raise FileProblem("old_text must be text copied from the file, and new_text its replacement.")
        text = full.read_text(encoding="utf-8")
        count = text.count(old_text)
        if count != 1:
            raise FileProblem(f"old_text appears {count} times in {rel}; it must appear exactly once. "
                              + ("Read the file and copy the text exactly." if count == 0 else "Include more of the text around it."))
        return self.write(rel, text.replace(old_text, new_text, 1)).replace("Wrote", "Edited", 1)

    def read(self, path: Any) -> str:
        rel, full = self.resolve(path)
        if not full.is_file():
            raise FileProblem(f"{rel} does not exist.")
        text = full.read_text(encoding="utf-8")
        return text if len(text) <= MAX_READ_CHARS else text[:MAX_READ_CHARS] + f"\n[... cut at {MAX_READ_CHARS:,} characters]"

    def delete(self, path: Any) -> str:
        rel, full = self.resolve(path)
        if not full.is_file():
            raise FileProblem(f"{rel} does not exist.")
        full.unlink()
        return f"Deleted {rel}."

    def listing(self) -> list[dict]:
        if not self.root.is_dir():
            return []
        return [{"path": p.relative_to(self.root).as_posix(), "size": p.stat().st_size}
                for p in sorted(self.root.rglob("*")) if p.is_file()]

    def fingerprint(self) -> str:
        """Changes whenever any file is added, removed or changed."""
        digest = hashlib.sha256()
        for f in self.listing():
            digest.update(f["path"].encode() + b"\0" + (self.root / f["path"]).read_bytes() + b"\0")
        return digest.hexdigest()

    def zip(self) -> bytes:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
            for f in self.listing():
                z.write(self.root / f["path"], f["path"])
        return buffer.getvalue()


@dataclass
class Site:
    id: str
    title: str
    dir: Path
    created: float = field(default_factory=time.time)
    history: list[dict] = field(default_factory=list)  # the conversation, as sent to Claude
    turns: list[dict] = field(default_factory=list)  # each message and Claude's reply, for the page
    checked: str | None = None  # fingerprint of the files Claude last saw screenshots of
    busy: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def files(self) -> SiteFiles:
        return SiteFiles(self.dir / "site")

    @property
    def shots(self) -> Path:
        return self.dir / "shots"


class SiteStore:
    """The sites on disk, one folder each: site/ holds the website, chat.json the conversation."""

    def __init__(self, root: Path):
        self.root = root
        self._sites: dict[str, Site] = {}
        self._lock = threading.Lock()

    def new(self, title: str) -> Site:
        site = Site(uuid.uuid4().hex[:12], title, Path())
        site.dir = self.root / site.id
        (site.dir / "site").mkdir(parents=True)
        with self._lock:
            self._sites[site.id] = site
        self.save(site)
        return site

    def get(self, site_id: str) -> Site | None:
        if not SITE_ID.match(site_id):
            return None
        with self._lock:
            if site_id in self._sites:
                return self._sites[site_id]
            saved = self.root / site_id / "chat.json"
            if not saved.is_file():
                return None
            data = json.loads(saved.read_text(encoding="utf-8"))
            site = Site(site_id, data["title"], self.root / site_id, data["created"], data["history"],
                        data["turns"], data.get("checked"))
            self._sites[site_id] = site
            return site

    def save(self, site: Site) -> None:
        data = {"title": site.title, "created": site.created, "turns": site.turns, "checked": site.checked,
                "history": site.history}
        tmp = site.dir / "chat.json.tmp"
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(site.dir / "chat.json")  # a crash mid-write never leaves half a file

    def list(self) -> list[dict]:
        if not self.root.is_dir():
            return []
        found = []
        for saved in self.root.glob("*/chat.json"):
            if site := self.get(saved.parent.name):
                found.append({"id": site.id, "title": site.title, "updated": saved.stat().st_mtime,
                              "turns": len(site.turns)})
        return sorted(found, key=lambda s: s["updated"], reverse=True)

    def delete(self, site_id: str) -> bool:
        site = self.get(site_id)
        if site is None:
            return False
        with self._lock:
            self._sites.pop(site_id, None)
        shutil.rmtree(site.dir, ignore_errors=True)
        return True


def as_param(block: Any) -> dict:
    """A response block as it is sent back to Claude, and saved."""
    return block.model_dump(mode="json", exclude_none=True)


def review_message(capture: Any, last: bool) -> list[dict]:
    desktop = sum(1 for name, _ in capture.shots if name.startswith("desktop"))
    phone = len(capture.shots) - desktop
    errors = ("Console errors while the page loaded:\n" + "\n".join(f"- {e}" for e in capture.errors)
              if capture.errors else "There were no console errors.")
    content: list[dict] = [{"type": "text", "text": REVIEW.format(
        desktop=f"{desktop} screen{'s' if desktop != 1 else ''}", phone=f"{phone} screen{'s' if phone != 1 else ''}",
        errors=errors, action=FIX_LAST if last else FIX)}]
    for name, png in capture.shots:
        content += [{"type": "text", "text": name},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                 "data": base64.b64encode(png).decode()}}]
    return content


class SiteService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, streamer: RunStreamer, store: SiteStore,
                 browser: Screenshotter, preview_origin: str):
        self.claude, self.spend, self.streamer, self.store = claude, spend, streamer, store
        self.browser, self.preview_origin = browser, preview_origin

    def site(self, site_id: str) -> Site:
        site = self.store.get(site_id)
        if site is None:
            raise ApiError(404, "not_found", "There is no site with that id.")
        return site

    def turn(self, site_id: str | None, prompt: str, model: str | None) -> Iterator[str]:
        """Checks the request, then starts one turn of the conversation and returns its stream of events."""
        prompt = prompt.strip()
        if not prompt or len(prompt) > MAX_PROMPT_CHARS:
            raise ApiError(400, "invalid_request", f"Write a request of 1 to {MAX_PROMPT_CHARS:,} characters.")
        site = self.site(site_id) if site_id else self.store.new(prompt.splitlines()[0][:70])
        if not site.busy.acquire(blocking=False):
            raise ApiError(409, "busy", "Claude is still working on this site. Wait for it, or press Stop.")
        model = model or DEFAULT_MODEL
        run = Run()

        def work() -> None:
            try:
                self._turn(site, model, run, prompt)
            finally:
                site.busy.release()

        return self.streamer.lines(run, work)

    def _turn(self, site: Site, model: str, run: Run, prompt: str) -> None:
        run.publish({"type": "site", "site_id": site.id, "title": site.title, "turn": len(site.turns) + 1,
                     "model": model})
        start = len(site.history)  # where this turn begins in the conversation, for restoring to before it
        messages = [*site.history, {"role": "user", "content": [{"type": "text", "text": prompt}]}]
        checked, rounds, cost, reply = site.checked, 0, 0.0, ""
        try:
            for n in range(1, MAX_REQUESTS + 1):
                if run.cancelled.is_set():
                    break
                if self.spend.over_budget:
                    run.publish({"type": "error", "message": f"The server's {money(self.spend.budget_usd)} budget "
                                                             "is used up. Restart it with a higher --budget."})
                    break
                final, done = self._request(messages, model, run, site)
                if final is None:  # stopped while Claude was writing
                    break
                spent = cost_usd(final.usage, model) or 0.0
                cost += spent
                self.spend.charge(final, model)
                run.publish({"type": "request", "turn": n, "stop_reason": final.stop_reason,
                             "usage": describe_usage(final.usage, model), "cost": spent})
                messages.append({"role": "assistant", "content": [as_param(b) for b in final.content]})
                reply = text_of(final).strip() or reply
                uses = [b for b in final.content if b.type == "tool_use"]
                if uses:
                    # Most calls already ran while the response streamed; a call cut off by max_tokens never does.
                    cut = final.stop_reason == "max_tokens"
                    messages.append({"role": "user", "content": [
                        done.get(b.id) or self._run_tool(site, b.id, b.name, b.input, run, cut) for b in uses]})
                    continue
                if final.stop_reason == "refusal":
                    run.publish({"type": "error", "message": "Claude declined this request."})
                    break
                # Claude has finished. Show it the site if anything changed since it last looked.
                fingerprint = site.files.fingerprint()
                if not site.files.listing() or fingerprint == checked or rounds >= REVIEW_ROUNDS:
                    break
                rounds += 1
                checked = fingerprint
                review = self._screenshots(site, run, rounds)
                if review is None:
                    break
                messages.append({"role": "user", "content": review})
            else:
                run.publish({"type": "error", "message": f"Stopped after {MAX_REQUESTS} requests in one message."})
        finally:
            # The history is always valid: every tool call is followed by its result.
            site.history, site.checked = messages, checked
            site.turns.append({"prompt": prompt, "reply": reply, "model": model, "time": time.time(), "start": start})
            self.store.save(site)
            run.publish({"type": "files", "files": site.files.listing(), "cost": round(cost, 4),
                         "spent_usd": round(self.spend.spent_usd, 4)})

    def restore(self, site_id: str, keep: int) -> Site:
        """Puts the site back as it was before message number `keep` (0 is the first): the conversation
        is cut there and the files are rebuilt by replaying every file change Claude made before it.
        The current files are moved to backups/, never deleted."""
        site = self.site(site_id)
        if not 0 <= keep < len(site.turns):
            raise ApiError(400, "invalid_request", f"Choose a message from 0 to {len(site.turns) - 1}.")
        if not site.busy.acquire(blocking=False):
            raise ApiError(409, "busy", "Claude is still working on this site. Stop it first.")
        try:
            start = turn_start(site, keep)
            history = site.history[:start]
            backup = site.dir / "backups" / time.strftime("%Y%m%d-%H%M%S")
            backup.mkdir(parents=True, exist_ok=True)
            if (site.dir / "site").exists():
                shutil.move(str(site.dir / "site"), str(backup / "site"))
            (site.dir / "site").mkdir()
            replay(history, site.files)
            site.history, site.turns, site.checked = history, site.turns[:keep], None
            self.store.save(site)
            return site
        finally:
            site.busy.release()

    def _request(self, messages: list[dict], model: str, run: Run, site: Site) -> tuple[Any, dict[str, dict]]:
        """One streamed request. Code is sent to the page as Claude writes it, and each tool call runs as soon
        as Claude has finished writing it, so the preview updates file by file instead of at the end.
        Returns the response, or None if the run was stopped, and the results of the calls that ran."""
        params = {"model": model, "max_tokens": MAX_TOKENS, "system": SYSTEM, "tools": TOOLS,
                  "messages": messages, "cache_control": {"type": "ephemeral"}}  # caches the whole conversation
        live: dict[str, Any] | None = None
        done: dict[str, dict] = {}
        with self.claude.stream(**params) as stream:
            for event in stream:
                if run.cancelled.is_set():
                    return None, done
                if event.type == "content_block_start" and event.content_block.type == "tool_use":
                    block = event.content_block
                    live = {"id": block.id, "name": block.name, "json": "", "sent": 0, "at": 0.0, "path": None}
                    if block.name in WRITERS:
                        run.publish({"type": "file_start", "id": block.id, "tool": block.name})
                elif event.type == "content_block_delta" and event.delta.type == "input_json_delta" and live:
                    live["json"] += event.delta.partial_json
                    self._stream_code(live, run, done=False)
                elif event.type == "content_block_delta" and event.delta.type == "text_delta":
                    run.publish({"type": "text", "text": event.delta.text})
                elif event.type == "content_block_stop" and live:
                    self._stream_code(live, run, done=True)
                    try:  # complete JSON means the call is complete; one cut off mid-way is left to the end
                        args = json.loads(live["json"] or "{}")
                    except ValueError:
                        args = None
                    if isinstance(args, dict):
                        done[live["id"]] = self._run_tool(site, live["id"], live["name"], args, run, cut=False)
                    live = None
            return stream.get_final_message(), done

    @staticmethod
    def _stream_code(live: dict, run: Run, done: bool) -> None:
        """Sends the code written since the last update, at most every 150 ms or 200 characters."""
        key = WRITERS.get(live["name"])
        if key is None:
            return
        if not done and time.monotonic() - live["at"] < 0.15 and len(live["json"]) - live.get("parsed", 0) < 200:
            return
        live["parsed"] = len(live["json"])
        try:  # the tool input so far, keeping the unfinished string at the end
            partial = from_json(live["json"].encode(), partial_mode="trailing-strings") if live["json"] else {}
        except ValueError:
            return
        code = partial.get(key) if isinstance(partial, dict) else None
        if not isinstance(code, str):
            return
        if live["path"] is None and isinstance(partial.get("path"), str):
            live["path"] = partial["path"]  # complete by now: it comes before the code
        if len(code) > live["sent"]:
            run.publish({"type": "file_delta", "id": live["id"], "path": live["path"], "text": code[live["sent"]:]})
            live["sent"], live["at"] = len(code), time.monotonic()

    def _run_tool(self, site: Site, tool_id: str, name: str, args: Any, run: Run, cut: bool) -> dict:
        args = args if isinstance(args, dict) else {}
        files = site.files
        try:
            if cut:
                raise FileProblem("Your response was cut off before this call was complete, so it was not run. "
                                  "Write large files in parts: create the file, then add to it with edit_file.")
            if name == "write_file":
                result = files.write(args.get("path"), args.get("content"))
            elif name == "edit_file":
                result = files.edit(args.get("path"), args.get("old_text"), args.get("new_text"))
            elif name == "delete_file":
                result = files.delete(args.get("path"))
            elif name == "read_file":
                result = files.read(args.get("path"))
            elif name == "list_files":
                listing = files.listing()
                result = "\n".join(f"{f['path']} ({f['size']:,} bytes)" for f in listing) or "The site has no files yet."
            else:
                raise FileProblem(f"There is no tool called {name}.")
        except FileProblem as problem:
            run.publish({"type": "tool", "id": tool_id, "tool": name, "path": args.get("path"), "ok": False,
                         "detail": str(problem)})
            return {"type": "tool_result", "tool_use_id": tool_id, "content": str(problem), "is_error": True}
        changed = name in ("write_file", "edit_file", "delete_file")
        run.publish({"type": "tool", "id": tool_id, "tool": name, "path": args.get("path"), "ok": True,
                     "detail": result if changed or name == "list_files" else f"{len(result):,} characters",
                     **({"files": files.listing()} if changed else {})})
        return {"type": "tool_result", "tool_use_id": tool_id, "content": result}

    def _screenshots(self, site: Site, run: Run, round_: int) -> list[dict] | None:
        """Screenshots the site and returns the message that shows them to Claude. None if that was not possible."""
        if not self.browser.available:
            run.publish({"type": "check", "round": round_, "shots": [],
                         "text": "No Chrome was found on the server, so the site was not checked by eye. "
                                 "Set LLM_LAB_CHROME to the path of Chrome or Chromium."})
            return None
        run.publish({"type": "check_start", "round": round_})
        try:
            capture = self.browser.capture(f"{self.preview_origin}/sites/{site.id}/index.html", [DESKTOP, PHONE])
        except Exception as exc:  # a broken page or a missing browser must not lose the turn
            run.publish({"type": "check", "round": round_, "shots": [], "text": f"The screenshots failed: {exc}"})
            return None
        site.shots.mkdir(exist_ok=True)
        names = []
        for name, png in capture.shots:
            file = f"r{round_}-{int(time.time())}-{name}.png"
            (site.shots / file).write_bytes(png)
            names.append({"name": name, "file": file})
        run.publish({"type": "check", "round": round_, "shots": names, "errors": capture.errors})
        return review_message(capture, last=round_ == REVIEW_ROUNDS)


def turn_start(site: Site, index: int) -> int:
    """Where a turn begins in the conversation. Older sites did not record it, so it is found by its prompt."""
    turn = site.turns[index]
    if isinstance(turn.get("start"), int):
        return turn["start"]
    seen = -1
    for i, message in enumerate(site.history):
        content = message["content"]
        if (message["role"] == "user" and isinstance(content, list) and len(content) == 1
                and content[0].get("type") == "text" and content[0].get("text") == turn["prompt"]):
            seen += 1
            prompts_before = sum(1 for t in site.turns[:index] if t["prompt"] == turn["prompt"])
            if seen == prompts_before:
                return i
    raise ApiError(409, "conflict", "This message could not be found in the saved conversation.")


def replay(history: list[dict], files: SiteFiles) -> None:
    """Re-applies, in order, every file change in the conversation that succeeded at the time."""
    failed = {block["tool_use_id"] for message in history if message["role"] == "user" and isinstance(message["content"], list)
              for block in message["content"] if block.get("type") == "tool_result" and block.get("is_error")}
    for message in history:
        if message["role"] != "assistant":
            continue
        for block in message["content"]:
            if block.get("type") != "tool_use" or block.get("id") in failed:
                continue
            args = block.get("input") or {}
            try:
                if block["name"] == "write_file":
                    files.write(args.get("path"), args.get("content"))
                elif block["name"] == "edit_file":
                    files.edit(args.get("path"), args.get("old_text"), args.get("new_text"))
                elif block["name"] == "delete_file":
                    files.delete(args.get("path"))
            except FileProblem:
                pass  # it succeeded then; if it cannot now, the rest of the site is still rebuilt
