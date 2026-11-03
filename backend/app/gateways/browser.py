"""Screenshots of a web page from headless Chrome, for Claude to check the sites it builds.

Chrome is driven over the DevTools protocol rather than with --screenshot, because that is the
only way to emulate a phone's width (headless Chrome will not lay a window out narrower than
500 pixels) and to collect the page's console errors. The page is scrolled to each part before
it is captured, so content that appears on scroll is in the picture.
"""
from __future__ import annotations

import base64
import itertools
import json
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from websockets.sync.client import connect

CHROME_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
]
CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"]


@dataclass(frozen=True)
class Viewport:
    name: str
    width: int
    height: int
    mobile: bool
    max_shots: int  # a long page is captured in this many screens at most


DESKTOP = Viewport("desktop", 1280, 800, False, 3)
PHONE = Viewport("phone", 390, 844, True, 3)


@dataclass
class Capture:
    shots: list[tuple[str, bytes]] = field(default_factory=list)  # (name such as desktop-1, PNG)
    errors: list[str] = field(default_factory=list)  # console errors, uncaught exceptions, failed loads


class Screenshotter(Protocol):
    available: bool

    def capture(self, url: str, viewports: list[Viewport]) -> Capture: ...


def find_chrome() -> str | None:
    """Chrome or a Chromium-based browser in the usual install locations. LLM_LAB_CHROME, via Settings, overrides this."""
    return next((p for p in CHROME_PATHS if Path(p).is_file()), None) or next(
        (found for name in CHROME_NAMES if (found := shutil.which(name))), None)


class ChromeScreenshotter:
    def __init__(self, chrome: str | None = None, timeout_s: float = 45.0):
        self.chrome = chrome or find_chrome()
        self.timeout_s = timeout_s

    @property
    def available(self) -> bool:
        return self.chrome is not None

    def capture(self, url: str, viewports: list[Viewport]) -> Capture:
        if not self.chrome:
            raise RuntimeError("No Chrome or Chromium was found. Set LLM_LAB_CHROME to its path.")
        profile = tempfile.mkdtemp(prefix="llm-lab-chrome-")
        proc = subprocess.Popen(
            [self.chrome, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={profile}",
             "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
             "--mute-audio", "--disable-extensions", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            with _DevTools(_browser_url(profile, proc), self.timeout_s) as tools:
                return tools.capture(url, viewports)
        finally:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
            shutil.rmtree(profile, ignore_errors=True)


def _browser_url(profile: str, proc: subprocess.Popen) -> str:
    """Chrome writes its DevTools port and path to this file once it is listening."""
    port_file = Path(profile) / "DevToolsActivePort"
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("Chrome exited before it was ready.")
        lines = port_file.read_text().split() if port_file.is_file() else []
        if len(lines) >= 2:
            return f"ws://127.0.0.1:{lines[0]}{lines[1]}"
        time.sleep(0.1)
    raise RuntimeError("Chrome did not start within 15 seconds.")


class _DevTools:
    """A minimal DevTools protocol client: send a command, wait for its reply, keep the events."""

    def __init__(self, url: str, timeout_s: float):
        self.url, self.deadline = url, time.monotonic() + timeout_s
        self.ids = itertools.count(1)
        self.events: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self.session: str | None = None

    def __enter__(self) -> "_DevTools":
        self.ws = connect(self.url, max_size=None, open_timeout=10)
        return self

    def __exit__(self, *exc: Any) -> None:
        self.ws.close()

    def _remaining(self) -> float:
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("Taking the screenshots took too long.")
        return left

    def call(self, method: str, params: dict | None = None) -> dict:
        msg_id = next(self.ids)
        msg: dict[str, Any] = {"id": msg_id, "method": method, "params": params or {}}
        if self.session and not method.startswith(("Target.", "Browser.")):
            msg["sessionId"] = self.session
        self.ws.send(json.dumps(msg))
        while True:
            reply = json.loads(self.ws.recv(timeout=self._remaining()))
            if reply.get("id") == msg_id:
                if "error" in reply:
                    raise RuntimeError(f"{method}: {reply['error'].get('message')}")
                return reply.get("result", {})
            self._note(reply)

    def wait_for(self, method: str, timeout_s: float) -> bool:
        """Waits for an event, keeping the others. False if it did not arrive in time."""
        if any(e.get("method") == method for e in self.events):
            return True
        end = time.monotonic() + timeout_s
        while (left := min(end - time.monotonic(), self._remaining())) > 0:
            try:
                event = json.loads(self.ws.recv(timeout=left))
            except TimeoutError:
                return False
            self._note(event)
            if event.get("method") == method:
                return True
        return False

    def _note(self, event: dict) -> None:
        self.events.append(event)
        method, params = event.get("method"), event.get("params", {})
        if method == "Runtime.exceptionThrown":
            details = params.get("exceptionDetails", {})
            text = details.get("exception", {}).get("description") or details.get("text", "")
            self.errors.append(f"Uncaught: {text.splitlines()[0] if text else 'exception'}")
        elif method == "Runtime.consoleAPICalled" and params.get("type") == "error":
            parts = [str(a.get("value", a.get("description", ""))) for a in params.get("args", [])]
            self.errors.append(f"console.error: {' '.join(parts)[:300]}")
        elif method == "Log.entryAdded" and params.get("entry", {}).get("level") == "error":
            entry = params["entry"]
            self.errors.append(f"{entry.get('text', '')[:300]}{' ' + entry['url'] if entry.get('url') else ''}")

    def capture(self, url: str, viewports: list[Viewport]) -> Capture:
        target = self.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.session = self.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        for domain in ("Page", "Runtime", "Log"):
            self.call(f"{domain}.enable")
        result = Capture()
        for vp in viewports:
            self.call("Emulation.setDeviceMetricsOverride",
                      {"width": vp.width, "height": vp.height, "deviceScaleFactor": 1, "mobile": vp.mobile})
            self.events.clear()
            self.call("Page.navigate", {"url": url})
            self.wait_for("Page.loadEventFired", 10)
            time.sleep(0.6)  # web fonts, entrance animations and scripts that run after load
            height = self.call("Runtime.evaluate", {
                "expression": "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)",
                "returnByValue": True})["result"].get("value") or vp.height
            bottom = max(0, int(height) - vp.height)
            screens = max(1, min(vp.max_shots, -(-int(height) // vp.height)))
            for i in range(screens):
                # Screens from the top; when the page is longer than max_shots screens, the last shows its end.
                top = bottom if i == screens - 1 else min(i * vp.height, bottom)
                self.call("Runtime.evaluate", {"expression": f"window.scrollTo(0, {top})"})
                time.sleep(0.35)  # let scroll-triggered content appear
                png = base64.b64decode(self.call("Page.captureScreenshot", {"format": "png"})["data"])
                result.shots.append((f"{vp.name}-{i + 1}", png))
        result.errors = [e for e in dict.fromkeys(self.errors) if "favicon.ico" not in e][:20]
        self.call("Target.closeTarget", {"targetId": target})
        return result
