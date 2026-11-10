"""One headless Chrome tab driven over the DevTools protocol, for the browsing and computer use agents.

24_browser_agent.py and 25_computer_use_agent.py run Claude's browser and computer toolsets against this tab. The
toolsets are client-side: Claude asks for a click or a screenshot, and this code does it. Chrome gets a fresh profile
in a temporary folder, so it has no cookies, logins or history from your own browser.

With allowed_origins set, every request the tab makes (pages, frames, scripts, images, redirects) is checked, and
anything outside the list is blocked in the browser itself. That is the domain allowlist the toolset documentation asks
for, and it holds whatever the page or the model tries.
"""
from __future__ import annotations

import base64
import contextlib
import itertools
import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from settings import ENV

CHROME_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
]
CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"]

# DevTools modifier bits.
MODIFIERS = {"alt": 1, "ctrl": 2, "control": 2, "meta": 4, "super": 4, "cmd": 4, "command": 4, "shift": 8}
# Key names Claude uses (xdotool style for the computer toolset, DOM style for the browser toolset) mapped to
# DOM key, DOM code and Windows virtual key code.
KEYS: dict[str, tuple[str, str, int]] = {
    "enter": ("Enter", "Enter", 13), "return": ("Enter", "Enter", 13), "kp_enter": ("Enter", "NumpadEnter", 13),
    "tab": ("Tab", "Tab", 9), "backspace": ("Backspace", "Backspace", 8), "escape": ("Escape", "Escape", 27),
    "esc": ("Escape", "Escape", 27), "delete": ("Delete", "Delete", 46), "space": (" ", "Space", 32),
    "up": ("ArrowUp", "ArrowUp", 38), "down": ("ArrowDown", "ArrowDown", 40), "left": ("ArrowLeft", "ArrowLeft", 37),
    "right": ("ArrowRight", "ArrowRight", 39), "arrowup": ("ArrowUp", "ArrowUp", 38),
    "arrowdown": ("ArrowDown", "ArrowDown", 40), "arrowleft": ("ArrowLeft", "ArrowLeft", 37),
    "arrowright": ("ArrowRight", "ArrowRight", 39), "home": ("Home", "Home", 36), "end": ("End", "End", 35),
    "pageup": ("PageUp", "PageUp", 33), "page_up": ("PageUp", "PageUp", 33), "pagedown": ("PageDown", "PageDown", 34),
    "page_down": ("PageDown", "PageDown", 34),
}
TEXT_FOR_KEY = {"Enter": "\r", "Tab": "\t", " ": " "}
# Shortcuts headless Chrome does not perform from key events alone, sent as editing commands instead.
EDIT_COMMANDS = {"a": "selectAll", "c": "copy", "x": "cut", "v": "paste", "z": "undo"}


def find_chrome() -> str | None:
    """Chrome or a Chromium-based browser. LLM_LAB_CHROME overrides the usual install locations."""
    return ENV.chrome_path or next((p for p in CHROME_PATHS if Path(p).is_file()), None) or next(
        (found for name in CHROME_NAMES if (found := shutil.which(name))), None)


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


class BrowserError(RuntimeError):
    """A browser action that failed, reported to the model as an error result."""


class Chrome:
    """A headless Chrome with one tab of a fixed size. Use it as a context manager."""

    def __init__(self, width: int = 1280, height: int = 800, allowed_origins: set[str] | None = None,
                 timeout_s: float = 20.0):
        self.width, self.height, self.timeout_s = width, height, timeout_s
        self.allowed = {o.lower() for o in allowed_origins} if allowed_origins else None
        self.blocked: list[str] = []  # URLs the allowlist stopped, for the summary
        self.mouse = (0, 0)
        self.ids = itertools.count(1)
        self.session: str | None = None
        self.events: list[dict] = []

    # ----- start and stop -----

    def __enter__(self) -> "Chrome":
        from websockets.sync.client import connect  # only these two scripts need websockets

        chrome = find_chrome()
        if not chrome:
            raise SystemExit("No Chrome or Chromium was found. Install one, or set LLM_LAB_CHROME to its path.")
        self.profile = tempfile.mkdtemp(prefix="llm-lab-agent-chrome-")
        self.proc = subprocess.Popen(
            [chrome, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={self.profile}",
             "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
             "--disable-extensions", "--disable-background-networking", "--disable-sync", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.stack = contextlib.ExitStack()
        self.ws = self.stack.enter_context(connect(self._browser_url(), max_size=None, open_timeout=10))
        target = self.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.session = self.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        for domain in ("Page", "Runtime"):
            self.call(f"{domain}.enable")
        self.call("Emulation.setDeviceMetricsOverride",
                  {"width": self.width, "height": self.height, "deviceScaleFactor": 1, "mobile": False})
        if self.allowed is not None:
            self.call("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]})
        return self

    def __exit__(self, *exc: Any) -> None:
        try:
            self.stack.close()
        finally:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            shutil.rmtree(self.profile, ignore_errors=True)

    def _browser_url(self) -> str:
        port_file = Path(self.profile) / "DevToolsActivePort"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise SystemExit("Chrome exited before it was ready.")
            lines = port_file.read_text().split() if port_file.is_file() else []
            if len(lines) >= 2:
                return f"ws://127.0.0.1:{lines[0]}{lines[1]}"
            time.sleep(0.1)
        raise SystemExit("Chrome did not start within 15 seconds.")

    # ----- the protocol -----

    def call(self, method: str, params: dict | None = None) -> dict:
        msg_id = next(self.ids)
        self._send(msg_id, method, params or {})
        deadline = time.monotonic() + self.timeout_s
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise BrowserError(f"{method} took too long.")
            reply = json.loads(self.ws.recv(timeout=left))
            if reply.get("id") == msg_id:
                if "error" in reply:
                    raise BrowserError(f"{method}: {reply['error'].get('message')}")
                return reply.get("result", {})
            self._note(reply)

    def _send(self, msg_id: int, method: str, params: dict) -> None:
        msg: dict[str, Any] = {"id": msg_id, "method": method, "params": params}
        if self.session and not method.startswith(("Target.", "Browser.")):
            msg["sessionId"] = self.session
        self.ws.send(json.dumps(msg))

    def _note(self, event: dict) -> None:
        """Keeps events, and answers the allowlist's paused requests at once so the page never stalls."""
        if event.get("method") == "Fetch.requestPaused":
            params = event["params"]
            url = params["request"]["url"]
            if url.startswith(("data:", "blob:")) or origin_of(url) in (self.allowed or set()):
                self._send(next(self.ids), "Fetch.continueRequest", {"requestId": params["requestId"]})
            else:
                self.blocked.append(url)
                self._send(next(self.ids), "Fetch.failRequest",
                           {"requestId": params["requestId"], "errorReason": "BlockedByClient"})
            return
        self.events.append(event)

    def settle(self, seconds: float = 0.3) -> None:
        """Lets the page react (and the allowlist answer requests) before the next look at it."""
        end = time.monotonic() + seconds
        while (left := end - time.monotonic()) > 0:
            try:
                self._note(json.loads(self.ws.recv(timeout=left)))
            except TimeoutError:
                return

    def evaluate(self, expression: str) -> Any:
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True,
                                                "awaitPromise": True})
        if "exceptionDetails" in result:
            raise BrowserError(result["exceptionDetails"].get("exception", {}).get("description", "script error"))
        return result.get("result", {}).get("value")

    # ----- what the page is -----

    @property
    def url(self) -> str:
        return self.evaluate("location.href") or ""

    @property
    def title(self) -> str:
        return self.evaluate("document.title") or ""

    def navigate(self, url: str) -> None:
        if self.allowed is not None and origin_of(url) not in self.allowed:
            self.blocked.append(url)
            raise BrowserError(f"{origin_of(url)} is not on this agent's allowlist. The page was not opened.")
        self.events.clear()
        result = self.call("Page.navigate", {"url": url})
        if result.get("errorText"):
            raise BrowserError(f"Could not open {url}: {result['errorText']}")
        self.wait_for_load()

    def history(self, step: int) -> None:
        """step -1 goes back, +1 forward, 0 reloads."""
        if step == 0:
            self.call("Page.reload")
        else:
            entries = self.call("Page.getNavigationHistory")
            index = entries["currentIndex"] + step
            if not 0 <= index < len(entries["entries"]):
                raise BrowserError("There is no page in that direction.")
            self.call("Page.navigateToHistoryEntry", {"entryId": entries["entries"][index]["id"]})
        self.wait_for_load()

    def wait_for_load(self, timeout_s: float = 8.0) -> None:
        end = time.monotonic() + timeout_s
        while time.monotonic() < end:
            if self.evaluate("document.readyState") == "complete":
                break
            self.settle(0.1)
        self.settle(0.2)

    def screenshot(self, clip: tuple[int, int, int, int] | None = None, scale: float = 1.0) -> bytes:
        params: dict[str, Any] = {"format": "png"}
        if clip:
            x0, y0, x1, y1 = clip
            params["clip"] = {"x": x0, "y": y0, "width": max(1, x1 - x0), "height": max(1, y1 - y0), "scale": scale}
        return base64.b64decode(self.call("Page.captureScreenshot", params)["data"])

    def zoom(self, region: list[int]) -> bytes:
        """A region of the screen, enlarged to about the screen's width so small text is readable."""
        x0, y0, x1, y1 = (int(v) for v in region)
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(self.width, x1), min(self.height, y1)
        if x1 <= x0 or y1 <= y0:
            raise BrowserError("The zoom region is empty or off the screen.")
        scale = min(4.0, self.width / (x1 - x0), self.height / (y1 - y0))
        return self.screenshot((x0, y0, x1, y1), max(1.0, scale))

    # ----- mouse and keyboard -----

    def _mods(self, text: str | list[str] | None) -> int:
        names = text if isinstance(text, list) else (text.split("+") if text else [])
        return sum(MODIFIERS.get(n.strip().lower(), 0) for n in names)

    def _mouse(self, kind: str, x: int, y: int, button: str = "none", clicks: int = 0, mods: int = 0) -> None:
        self.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": button,
                                               "clickCount": clicks, "modifiers": mods})

    def _check(self, x: int, y: int) -> tuple[int, int]:
        x, y = int(x), int(y)
        if not (0 <= x < self.width and 0 <= y < self.height):
            raise BrowserError(f"({x}, {y}) is off the screen, which is {self.width} by {self.height}.")
        return x, y

    def move(self, x: int, y: int) -> None:
        x, y = self._check(x, y)
        self._mouse("mouseMoved", x, y)
        self.mouse = (x, y)

    def click(self, x: int, y: int, button: str = "left", count: int = 1, modifiers: str | list | None = None) -> None:
        x, y = self._check(x, y)
        mods = self._mods(modifiers)
        self._mouse("mouseMoved", x, y, mods=mods)
        for n in range(1, count + 1):  # a double click is two clicks, the second with clickCount 2
            self._mouse("mousePressed", x, y, button, n, mods)
            self._mouse("mouseReleased", x, y, button, n, mods)
        self.mouse = (x, y)
        self.settle()

    def mouse_down(self) -> None:
        self._mouse("mousePressed", *self.mouse, "left", 1)

    def mouse_up(self) -> None:
        self._mouse("mouseReleased", *self.mouse, "left", 1)
        self.settle()

    def drag(self, start: tuple[int, int], end: tuple[int, int], modifiers: str | list | None = None) -> None:
        (x0, y0), (x1, y1) = self._check(*start), self._check(*end)
        mods = self._mods(modifiers)
        self._mouse("mouseMoved", x0, y0, mods=mods)
        self._mouse("mousePressed", x0, y0, "left", 1, mods)
        for i in range(1, 11):
            self.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x0 + (x1 - x0) * i // 10,
                                                   "y": y0 + (y1 - y0) * i // 10, "button": "left", "buttons": 1,
                                                   "modifiers": mods})
        self._mouse("mouseReleased", x1, y1, "left", 1, mods)
        self.mouse = (x1, y1)
        self.settle()

    def scroll(self, x: int, y: int, direction: str, notches: int = 3, modifiers: str | list | None = None) -> None:
        x, y = self._check(x, y)
        step = 100 * max(1, min(10, int(notches)))
        dx, dy = {"up": (0, -step), "down": (0, step), "left": (-step, 0), "right": (step, 0)}[direction]
        self.call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy,
                                               "modifiers": self._mods(modifiers)})
        self.mouse = (x, y)
        self.settle(0.4)

    def type_text(self, text: str) -> None:
        """Types at the focused element. Newlines press Enter, so a form can be submitted by typing."""
        for i, line in enumerate(text.split("\n")):
            if i:
                self.key("Enter")
            if line:
                self.call("Input.insertText", {"text": line})
        self.settle()

    def key(self, combo: str, repeat: int = 1) -> None:
        """Presses a key or chord such as Return, ctrl+s or shift+Tab. Spaces separate a sequence of presses."""
        for _ in range(max(1, min(100, int(repeat)))):
            for chord in combo.split():
                self._chord(chord)
        self.settle()

    def _chord(self, chord: str) -> None:
        parts = chord.split("+") if chord != "+" else ["+"]
        mods = self._mods(parts[:-1])
        name = parts[-1]
        key, code, vk = KEYS.get(name.lower(), (None, None, None))
        if key is None:
            if len(name) != 1:
                raise BrowserError(f"Unknown key '{name}'.")
            key = name.upper() if mods & 8 else name
            code = f"Key{name.upper()}" if name.isalpha() else (f"Digit{name}" if name.isdigit() else "")
            vk = ord(name.upper())
        params: dict[str, Any] = {"key": key, "code": code, "windowsVirtualKeyCode": vk, "modifiers": mods}
        text = TEXT_FOR_KEY.get(key, key if len(key) == 1 else "")
        down: dict[str, Any] = {"type": "keyDown" if (text and not mods & 7) else "rawKeyDown", **params}
        if text and not mods & 7:
            down["text"] = text
        if mods & 6 and name.lower() in EDIT_COMMANDS:  # ctrl or cmd shortcuts headless Chrome ignores
            down["commands"] = [EDIT_COMMANDS[name.lower()]]
        self.call("Input.dispatchKeyEvent", down)
        self.call("Input.dispatchKeyEvent", {"type": "keyUp", **params})

    def hold_key(self, combo: str, seconds: float) -> None:
        parts = combo.split("+")
        mods = self._mods(parts[:-1])
        key, code, vk = KEYS.get(parts[-1].lower(), (parts[-1], "", ord(parts[-1][0].upper())))
        params = {"key": key, "code": code, "windowsVirtualKeyCode": vk, "modifiers": mods}
        self.call("Input.dispatchKeyEvent", {"type": "rawKeyDown", **params})
        time.sleep(min(seconds, 10))
        self.call("Input.dispatchKeyEvent", {"type": "keyUp", **params})
        self.settle()


def png_block(png: bytes) -> dict:
    """An image content block for a tool result."""
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                        "data": base64.b64encode(png).decode()}}
