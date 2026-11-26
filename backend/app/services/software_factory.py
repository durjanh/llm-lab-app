"""The software factory: agents do the delivery work on a copy of the practice project, and people set direction and
apply judgement where the risk calls for it.

Each ticket becomes a change. A planner agent (read-only) proposes a plan, an implementer agent builds it in the
lab's sandbox, and the change goes through gates: the project's tests (which must not be deleted or skipped), simple
policy checks, a reviewer agent with its own context, and a budget of money and time. How much a person is involved
depends on the change's tier (factory_policy): low-risk work merges with no person ("runs dark"), medium-risk work
waits for a person to approve the diff, and high-risk work waits for a person to approve the plan and then the diff.
Each merge is a real git commit in the factory's copy of the project; a revert records an escaped defect, which
costs the area its autonomy.

Everything lives in generated/software-factory/: the project (`project/`, a git repository), each change's own clone
(`changes/<id>/project/`) and event log, `state.json` (tickets and changes) and `ledger.json` (the track record by
area). One change runs at a time, because every change merges into the same project.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..core.child_env import child_env
from ..core.errors import ApiError
from ..settings import MODELS, Settings
from ..shared import coding_script as C
from . import factory_policy as P
from .assistant_agent import efforts_for
from .runs import Run, RunRegistry, RunStreamer
from .spend import SpendTracker

STATUSES = ["queued", "planning", "awaiting_plan", "building", "checking", "awaiting_diff", "merged", "reverted",
            "rejected", "blocked", "taken_over", "stopped", "expired", "failed"]
FINISHED = {"merged", "reverted", "rejected", "blocked", "taken_over", "stopped", "expired", "failed"}
TEST_COMMAND = "python -m unittest -q 2>&1"
MAX_FIX_ROUNDS = 1  # automatic rounds to fix failed gates before the change is blocked
MAX_CHANGE_ROUNDS = 3  # times a person can ask for changes to one diff
MAX_TICKETS = 40
MAX_CHANGES_KEPT = 60
SECRET_PATTERNS = [r"AKIA[0-9A-Z]{16}", r"-----BEGIN [A-Z ]*PRIVATE KEY-----", r"sk-[A-Za-z0-9]{20,}",
                   r"(?i)(password|secret|api[_-]?key|token)\s*=\s*['\"][^'\"]{6,}['\"]"]
SKIP_PATTERNS = [r"@unittest\.skip", r"\.skipTest\(", r"@unittest\.expectedFailure", r"pytest\.mark\.skip",
                 r"pytest\.skip\("]

# An invented backlog for the practice project (python/coding_project): a small bank-export ledger library.
BACKLOG: list[dict[str, str]] = [
    {"id": "T1", "title": "Add a README that says how to run the tests", "kind": "docs", "area": "docs",
     "description": "The project has no README. Add README.md with one paragraph on what the library does and the "
                    "command that runs the tests."},
    {"id": "T2", "title": "Dates are read month first", "kind": "bugfix", "area": "parsing",
     "description": "parse_date should read DD/MM/YYYY, but swaps the day and month. test_dates_are_day_first fails."},
    {"id": "T3", "title": "Amounts with a thousands separator fail to parse", "kind": "bugfix", "area": "parsing",
     "description": "parse_amount('£1,234.50') raises. Amounts must accept the £ sign and commas."},
    {"id": "T4", "title": "Category totals lose pennies", "kind": "bugfix", "area": "reporting",
     "description": "total_by_category adds floats, so 0.10 + 0.20 is not 0.30. Totals must be exact Decimals."},
    {"id": "T5", "title": "Report the biggest payees", "kind": "feature", "area": "reporting",
     "description": "Add top_payees(transactions, n) returning the n descriptions with the most money out, largest "
                    "first, as exact Decimals, with tests."},
    {"id": "T6", "title": "Separate reading the file from checking its rows", "kind": "refactor", "area": "parsing",
     "description": "read_csv both reads and converts. Split the conversion of one row into its own function without "
                    "changing behaviour."},
    {"id": "T7", "title": "Match refunds to the purchases they reverse", "kind": "feature", "area": "payments",
     "description": "Add ledger/payments.py with match_refunds(transactions): pair each refund (money in with the same "
                    "description as an earlier purchase and the same amount) with that purchase."},
    {"id": "T8", "title": "Read dates with a date library", "kind": "dependency", "area": "dependencies",
     "description": "Replace the hand-written date parsing with python-dateutil, added to requirements.txt."},
    {"id": "T9", "title": "Add a currency column to the export format", "kind": "schema", "area": "data",
     "description": "Bank exports now carry a currency code. Add an optional currency column (default GBP) to the "
                    "Transaction record and the CSV reader, keeping old files readable."},
    {"id": "T10", "title": "Refuse rows that would run as spreadsheet formulas", "kind": "security", "area": "security",
     "description": "A description starting with =, +, - or @ can run as a formula when the report is opened in a "
                    "spreadsheet. Reject or neutralise such descriptions when reading, with tests."},
]

PLAN_PROMPT = """You are the planner. Read the project and write a short plan for this ticket. Do not change anything.

Ticket {id}: {title}
Kind: {kind}. Area: {area}.
{description}

Answer with: the approach in two or three sentences, then numbered steps, then the tests that will prove it. End with
one line that lists every file you expect to change or create, exactly like this:
FILES: ledger/parse.py, tests/test_parse.py"""

BUILD_PROMPT = """You are the implementer. Make this change in the project, following the agreed plan.

Ticket {id}: {title}
{description}

Agreed plan:
{plan}

Rules: work only inside this project. Run the tests with `python -m unittest` and finish only when they pass. Never
delete, skip or weaken a test to make it pass; if a test seems wrong, say so instead. Keep the change as small as the
ticket allows. Finish with two sentences on what you changed."""

FIX_PROMPT = """The change did not pass its checks. Fix these, then run the tests again:

{problems}"""

REVIEW_PROMPT = """You are an independent reviewer. You did not write this change. Review it against the ticket, using
this checklist, and read any file you need.

Checklist: it does what the ticket asks and nothing else; no test was deleted, skipped or weakened; edge cases and
errors are handled; money stays exact (Decimal); no secrets, unsafe calls or new dependencies the ticket did not ask for;
the code is clear and small.

Ticket {id}: {title}
{description}

Test output:
{tests}

Diff:
{diff}

Finish with a JSON object on its own, in a ```json block, exactly in this shape:
{{"verdict": "pass" or "changes", "findings": [{{"severity": "high" or "medium" or "low", "file": "...", "issue": "..."}}]}}
Use "changes" if any finding is high or medium."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


GIT_SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.editor=true",
            "-c", "core.sshCommand=false", "-c", "diff.external=", "-c", "protocol.allow=never",
            "-c", "protocol.file.allow=always"]


def git(args: list[str], cwd: Path, timeout: int = 60) -> tuple[int, str]:
    """A git command, only ever in a repository the factory controls (the agent never sees a .git folder). Hooks,
    fsmonitor, editors, external diff tools and outside config files are all off, and it gets a minimal environment
    without the backend's keys, so nothing in a repository can make git run a program."""
    base = ["git", "-c", "user.name=Software factory", "-c", "user.email=factory@localhost", "-c",
            "commit.gpgsign=false", "-c", "core.pager=cat", *GIT_SAFE]
    env = child_env(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0",
                    GIT_CEILING_DIRECTORIES=str(cwd.parent), HOME=str(cwd.parent))
    try:
        p = subprocess.run([*base, *args], cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)
    return p.returncode, (p.stdout + p.stderr).strip()


def failures(output: str) -> set[str]:
    """The tests that failed or errored, from unittest's output, by their full names."""
    return {m[1] or m[0] for m in re.findall(r"^(?:FAIL|ERROR): (\S+) \(([^)]+)\)", output, re.M)}


SYNC_SKIP = {".git", "__pycache__", ".venv", "node_modules", ".pytest_cache"}
MAX_SYNC_FILE_BYTES = 2_000_000


def sync_tree(src: Path, dst: Path) -> list[str]:
    """Makes dst's files (outside its .git) match src's regular files. Never copies a .git folder, a link or a cache,
    so nothing the agent writes can become git configuration or a hook. Returns what it skipped."""
    keep: set[Path] = set()
    skipped: list[str] = []
    for dirpath, dirnames, filenames in os.walk(src, followlinks=False):
        here = Path(dirpath)
        dirnames[:] = [d for d in dirnames if d not in SYNC_SKIP and not (here / d).is_symlink()]
        for name in filenames:
            p = here / name
            rel = p.relative_to(src)
            if p.is_symlink() or not p.is_file() or name.endswith(".pyc"):
                skipped.append(f"{rel.as_posix()} (not a regular file)")
                continue
            if p.stat().st_size > MAX_SYNC_FILE_BYTES:
                skipped.append(f"{rel.as_posix()} (over {MAX_SYNC_FILE_BYTES:,} bytes)")
                continue
            keep.add(rel)
            target = dst / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_symlink():
                target.unlink()
            shutil.copyfile(p, target)
    for dirpath, dirnames, filenames in os.walk(dst, followlinks=False):
        here = Path(dirpath)
        dirnames[:] = [d for d in dirnames if d not in SYNC_SKIP]
        for name in filenames:
            p = here / name
            if p.relative_to(dst) not in keep:
                p.unlink()
    return skipped


def count_tests(text: str) -> int:
    return len(re.findall(r"^\s*def test_\w*\s*\(", text, re.M))


def parse_files(plan: str) -> list[str]:
    """The files a plan expects to touch, from its FILES: line."""
    m = re.findall(r"^\s*FILES:\s*(.+)$", plan, re.M)
    if not m:
        return []
    return [f.strip().strip("`") for f in m[-1].split(",") if f.strip() and len(f.strip()) < 200][:40]


def parse_review(text: str) -> dict[str, Any] | None:
    """The reviewer's JSON verdict, or None when it gave none it can be held to."""
    blocks = re.findall(r"```json\s*(\{.*?\})\s*```", text, re.S) or re.findall(r"(\{[^{}]*\"verdict\".*\})", text, re.S)
    for raw in reversed(blocks):
        try:
            v = json.loads(raw)
        except ValueError:
            continue
        if isinstance(v, dict) and v.get("verdict") in ("pass", "changes"):
            findings = [f for f in v.get("findings", []) if isinstance(f, dict)][:30]
            return {"verdict": v["verdict"], "findings": [{"severity": str(f.get("severity", "low"))[:10],
                                                           "file": str(f.get("file", ""))[:200],
                                                           "issue": str(f.get("issue", ""))[:600]} for f in findings]}
    return None


class Stopped(Exception):
    """The change stopped: the person pressed Stop or left, or its budget or time ran out."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason, self.message = reason, message


class SoftwareFactoryService:
    def __init__(self, claude: Any, spend: SpendTracker, registry: RunRegistry, streamer: RunStreamer, folder: Path,
                 settings: Settings, gpt: Any = None):
        self.claude, self.spend, self.registry, self.streamer, self.folder = claude, spend, registry, streamer, folder
        self.gpt = gpt
        self.change_budget_usd = settings.software_factory_change_budget_usd
        self.time_limit_s = settings.software_factory_time_limit_s
        self.decision_timeout_s = settings.software_factory_decision_timeout_s
        self.sandbox: Any = None  # tests put a fake here; None means the coding agent's SANDBOX
        self.make_agent: Callable[..., Any] | None = None  # tests put a factory of fake agents here
        self._lock = threading.Lock()  # the state file
        self._busy = threading.Lock()  # one change at a time: they all merge into the same project
        self._running: dict[str, Any] | None = None  # the change being worked on, its run and its stop flag
        self._decisions: dict[str, dict[str, Any]] = {}

    # ----- storage -----
    @property
    def project(self) -> Path:
        return self.folder / "project"

    def _read(self, name: str, default: Any) -> Any:
        path = self.folder / name
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def _write(self, name: str, data: Any) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        tmp = self.folder / f".{name}.tmp"
        tmp.write_text(json.dumps(data, indent=1, default=str), encoding="utf-8")
        tmp.replace(self.folder / name)

    def _state(self) -> dict[str, Any]:
        s = self._read("state.json", {})
        s.setdefault("tickets", [])
        s.setdefault("changes", [])
        return s

    def _ledger(self) -> dict[str, Any]:
        led = self._read("ledger.json", {})
        led.setdefault("areas", {})
        for area in P.AREAS:
            led["areas"].setdefault(area, P.new_area())
        return led

    def _ensure_project(self) -> None:
        """The factory's copy of the practice project, as a git repository with one starting commit."""
        if (self.project / ".git").is_dir():
            return
        if shutil.which("git") is None:
            raise ApiError(503, "no_git", "The software factory needs git on this machine.")
        self.project.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(C.PROJECT, self.project, ignore=shutil.ignore_patterns("__pycache__"), dirs_exist_ok=True)
        if (self.project / "CLAUDE.example.md").exists():
            (self.project / "CLAUDE.example.md").rename(self.project / "CLAUDE.md")
        # Running the tests leaves compiled files behind; they are not part of any change.
        (self.project / ".gitignore").write_text("__pycache__/\n*.pyc\n.venv/\n", encoding="utf-8")
        for args in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-qm", "Starting point"]):
            code, out = git(args, self.project)
            if code:
                raise ApiError(500, "git_failed", f"Could not set up the factory's project: {out[:300]}")

    def _update_change(self, change_id: str, fn: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        with self._lock:
            state = self._state()
            for c in state["changes"]:
                if c["id"] == change_id:
                    fn(c)
                    c["updated_at"] = now()
                    self._write("state.json", state)
                    return dict(c)
        raise ApiError(404, "not_found", "No such change.")

    def _update_ledger(self, fn: Callable[[dict[str, Any]], Any]) -> Any:
        with self._lock:
            led = self._ledger()
            out = fn(led)
            self._write("ledger.json", led)
            return out

    # ----- what the page reads -----
    def box(self) -> Any:
        box = self.sandbox if self.sandbox is not None else C.SANDBOX
        if box is None:
            raise ApiError(409, "no_sandbox", "The factory runs the agents' commands only in a sandbox, and none is set "
                                              "up. Start it with ./tools/sandbox.sh and set LLM_LAB_SANDBOX=docker.")
        return box

    def models(self) -> list[str]:
        gpt = [m for m in (self.gpt.models if self.gpt else []) if C.is_gpt(m) and "image" not in m]
        return list(dict.fromkeys([*MODELS, *gpt]))

    def info(self) -> dict[str, Any]:
        models = self.models()
        box = self.sandbox if self.sandbox is not None else C.SANDBOX
        return {"models": models, "default_model": "claude-haiku-5-5" if "claude-haiku-5-5" in models else models[0],
                "efforts": {m: efforts_for(m) for m in models},
                "kinds": P.KINDS, "areas": P.AREAS, "rules": P.rules(), "statuses": STATUSES,
                "change_budget_usd": self.change_budget_usd, "time_limit_s": self.time_limit_s,
                "decision_timeout_s": self.decision_timeout_s,
                "sandbox": {"available": box is not None, "kind": getattr(box, "kind", None)}}

    def tickets(self) -> list[dict[str, Any]]:
        led = self._ledger()
        out = []
        for t in [*BACKLOG, *self._state()["tickets"]]:
            tier, reasons = P.declared_tier(t["kind"], t["area"])
            level = led["areas"].get(t["area"], P.new_area())["level"]
            eff, why = P.effective_tier(tier, level, declared=tier)
            out.append({**t, "tier": tier, "tier_reasons": reasons, "effective_tier": eff, "effective_reason": why})
        return out

    def state(self) -> dict[str, Any]:
        state = self._state()
        changes = sorted(state["changes"], key=lambda c: c["created_at"], reverse=True)
        running = self._running["change_id"] if self._running else None
        return {"tickets": self.tickets(), "changes": [self._summary(c) for c in changes],
                "ledger": self._ledger()["areas"], "metrics": metrics(changes, self._ledger()["areas"]),
                "running": running}

    @staticmethod
    def _summary(c: dict[str, Any]) -> dict[str, Any]:
        keys = ("id", "ticket_id", "title", "area", "kind", "status", "tier", "policy_tier", "effective_tier",
                "created_at", "updated_at", "merged_at", "commit", "cost_usd", "model", "dark", "human_steps",
                "stopped_reason")
        return {k: c.get(k) for k in keys}

    def change(self, change_id: str) -> dict[str, Any]:
        for c in self._state()["changes"]:
            if c["id"] == change_id:
                return c
        raise ApiError(404, "not_found", "No such change.")

    # ----- tickets -----
    def add_ticket(self, title: str, description: str, kind: str, area: str) -> dict[str, Any]:
        title, description = (title or "").strip(), (description or "").strip()
        if not 3 <= len(title) <= 120:
            raise ApiError(400, "invalid_request", "A ticket needs a title of 3 to 120 characters.")
        if not 10 <= len(description) <= 2000:
            raise ApiError(400, "invalid_request", "Describe the ticket in 10 to 2,000 characters.")
        if kind not in P.KINDS or area not in P.AREAS:
            raise ApiError(400, "invalid_request", f"kind must be one of {', '.join(P.KINDS)}; area one of "
                                                   f"{', '.join(P.AREAS)}.")
        with self._lock:
            state = self._state()
            if len(state["tickets"]) >= MAX_TICKETS:
                raise ApiError(400, "invalid_request", f"At most {MAX_TICKETS} tickets of your own.")
            ticket = {"id": f"U{len(state['tickets']) + 1}", "title": title, "description": description, "kind": kind,
                      "area": area, "own": True}
            state["tickets"].append(ticket)
            self._write("state.json", state)
        return next(t for t in self.tickets() if t["id"] == ticket["id"])

    def _ticket(self, ticket_id: str) -> dict[str, Any]:
        for t in [*BACKLOG, *self._state()["tickets"]]:
            if t["id"] == ticket_id:
                return t
        raise ApiError(404, "not_found", "No such ticket.")

    # ----- a change, start to finish -----
    def start(self, ticket_id: str, model: str, effort: str = "low") -> Iterator[str]:
        ticket = self._ticket(ticket_id)
        if model not in self.models():
            raise ApiError(400, "invalid_request", f"model must be one of: {', '.join(self.models())}")
        allowed = efforts_for(model)
        effort = effort or ("low" if allowed else "")
        if effort and effort not in allowed:
            raise ApiError(400, "invalid_request", f"{model} takes effort {', '.join(allowed)}." if allowed else
                                                   f"{model} takes no effort setting; leave it empty.")
        self.box()
        if not self._busy.acquire(blocking=False):
            raise ApiError(409, "busy", "A change is already running. Every change merges into the same project, so "
                                        "they run one at a time.")
        try:
            self._ensure_project()
            run = Run()
            cid = secrets.token_hex(6)
            change = {"id": cid, "ticket_id": ticket["id"], "title": ticket["title"], "area": ticket["area"],
                      "kind": ticket["kind"], "description": ticket["description"], "status": "queued",
                      "model": model, "effort": effort, "created_at": now(), "updated_at": now(), "cost_usd": 0.0,
                      "plan": "", "plan_files": [], "diff": "", "files": [], "diff_lines": 0, "tests": None,
                      "review": None, "gates": [], "audit": [], "human_steps": 0, "corrections": 0, "dark": False,
                      "tier": None, "policy_tier": None, "effective_tier": None, "tier_reasons": [],
                      "merged_at": None, "commit": None, "stopped_reason": None}
            with self._lock:
                state = self._state()
                state["changes"].append(change)
                state["changes"] = state["changes"][-MAX_CHANGES_KEPT:]
                self._write("state.json", state)
            stop = threading.Event()
            self._running = {"change_id": cid, "run_id": run.id, "stop": stop, "reason": None}
        except BaseException:
            self._busy.release()
            raise

        def work() -> None:
            try:
                self._pipeline(cid, ticket, model, effort, run, stop)
            finally:
                self._running = None
                self._busy.release()

        return self.streamer.lines(run, work)

    def _pipeline(self, cid: str, ticket: dict[str, Any], model: str, effort: str, run: Run,
                  stop: threading.Event) -> None:
        folder = self.folder / "changes" / cid
        log_path = folder / "events.jsonl"
        folder.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.time_limit_s
        spent = {"usd": 0.0}

        def publish(event: dict[str, Any]) -> None:
            event = {**event, "change_id": cid, "ts": now()}
            try:
                with log_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(event, default=str) + "\n")
            except OSError:
                pass
            run.publish(event)

        def audit(actor: str, what: str, why: str = "") -> None:
            entry = {"at": now(), "actor": actor, "what": what, "why": why}
            self._update_change(cid, lambda c: c["audit"].append(entry))
            publish({"type": "audit", "entry": entry})

        def status(s: str, **fields: Any) -> None:
            c = self._update_change(cid, lambda c: c.update({"status": s, **fields}))
            publish({"type": "change", "change": c})

        # Stop when the page leaves or presses Stop, and when the time runs out.
        def watch() -> None:
            while not stop.is_set():
                if run.cancelled.wait(0.5):
                    self._stop_reason("stopped", "Stopped by the person.")
                    stop.set()
                elif time.monotonic() > deadline:
                    self._stop_reason("time", f"The change ran past its {self.time_limit_s} s time limit.")
                    stop.set()
        threading.Thread(target=watch, daemon=True).start()

        def check() -> None:
            if stop.is_set():
                r = self._running or {}
                raise Stopped(r.get("reason") or "stopped", r.get("message") or "Stopped.")
            if spent["usd"] >= self.change_budget_usd:
                raise Stopped("budget", f"The change reached its ${self.change_budget_usd:.2f} budget.")
            if self.spend.over_budget:
                raise Stopped("budget", "The lab's spending cap is reached.")

        def agent(role: str, mode: str, root: Path) -> Any:
            make = self.make_agent or self._real_agent
            a = make(role, model, root, mode, effort,
                     lambda e: publish({"type": "agent", "role": role, "event": e}))
            a.cancelled = stop
            return a

        def ask(a: Any, role: str, prompt: str) -> str:
            check()
            before = getattr(a, "spent", 0.0)
            a.budget = before + max(0.0, min(self.change_budget_usd - spent["usd"], self.spend.remaining_usd))
            try:
                return str(a.ask(prompt) or "")  # an empty reply is text too
            except C.StopRun as exc:
                check()
                raise Stopped("budget" if "budget" in str(exc) else "failed", f"The {role} stopped: {exc}") from exc
            finally:
                spent["usd"] += max(0.0, getattr(a, "spent", 0.0) - before)
                self._update_change(cid, lambda c: c.update({"cost_usd": round(spent["usd"], 6)}))

        try:
            publish({"type": "change", "change": self.change(cid)})
            # The factory's own clone, which only the backend touches, and a plain copy (no .git) for the agents.
            code, out = git(["clone", "-q", str(self.project), "repo"], folder)
            if code:
                raise RuntimeError(f"could not copy the project: {out[:200]}")
            repo, work = folder / "repo", folder / "work"
            work.mkdir()
            sync_tree(repo, work)
            _, base = git(["rev-parse", "HEAD"], repo)
            base_tests = test_counts(repo)
            # What already fails on main: a change is judged on the failures it adds, not on old ones.
            _, base_out = self._run_tests(work)
            base_failing = failures(base_out)
            self._update_change(cid, lambda c: c.update({"baseline": {"failing": sorted(base_failing)}}))
            audit("gate", "baseline tests", f"{len(base_failing)} already failing on main" if base_failing else
                  "all passing on main")
            level = self._ledger()["areas"][ticket["area"]]["level"]
            declared, reasons = P.declared_tier(ticket["kind"], ticket["area"])
            audit("policy", f"declared tier {declared}", "; ".join(reasons))

            # 1. Plan, read-only.
            status("planning", tier=declared, policy_tier=declared, tier_reasons=reasons)
            planner = agent("planner", "plan", work)
            plan = ask(planner, "planner", PLAN_PROMPT.format(**ticket)).strip()
            files = parse_files(plan)
            tier, more = P.raise_for_evidence(declared, P.Evidence(files=files))
            evidence = P.raise_for_evidence("low", P.Evidence(files=files))[0]
            eff, why = P.effective_tier(tier, level, declared=declared, evidence=evidence)
            self._update_change(cid, lambda c: c.update({"plan": plan, "plan_files": files, "policy_tier": tier,
                                                         "declared_tier": declared, "evidence_tier": evidence,
                                                         "tier": eff, "effective_tier": eff,
                                                         "tier_reasons": [*reasons, *more, why]}))
            audit("planner agent", "proposed a plan", f"files: {', '.join(files) or 'none named'}")
            audit("policy", f"tier {eff}", "; ".join([*more, why]))

            # 2. High risk: a person approves or edits the plan first.
            if eff == "high":
                status("awaiting_plan")
                d = self._decide(cid, run, publish, stop, "plan", {"plan": plan})
                self._person(cid, d, audit)
                if d["decision"] == "take_over":
                    return self._finish(cid, status, audit, "taken_over", "A person took the change over.")
                if d["decision"] != "approve":
                    return self._finish(cid, status, audit, "rejected", d.get("note") or "The plan was rejected.")
                if d.get("plan") and d["plan"].strip() != plan:
                    plan = d["plan"].strip()[:8000]
                    self._update_change(cid, lambda c: c.update({"plan": plan, "corrections": c["corrections"] + 1}))
                    audit("person", "edited the plan")

            # 3. Build, then the gates, with one automatic round to fix what they find.
            status("building")
            builder = agent("implementer", "auto", work)
            builder.own_test_gate = True  # the factory's stop check compares with the baseline instead
            builder.stop_hooks.append(lambda a: self._no_new_failures(a, base_failing))
            summary = ask(builder, "implementer", BUILD_PROMPT.format(plan=plan, **ticket))
            audit("implementer agent", "built the change", summary[:300])
            rounds_left, change_rounds = MAX_FIX_ROUNDS, 0
            while True:
                status("checking")
                result = self._gates(cid, ticket, work, repo, base, base_tests, base_failing, level, declared, agent,
                                     ask, publish, audit)
                eff = result["effective"]
                if not result["passed"]:
                    if rounds_left > 0:
                        rounds_left -= 1
                        status("building")
                        ask(builder, "implementer", FIX_PROMPT.format(problems="\n".join(result["problems"])))
                        audit("implementer agent", "fixed what the gates found")
                        continue
                    return self._finish(cid, status, audit, "blocked", "; ".join(result["problems"])[:600])
                if eff == "low":
                    break
                status("awaiting_diff")
                d = self._decide(cid, run, publish, stop, "diff", {"diff": result["diff"][:60000]})
                self._person(cid, d, audit)
                if d["decision"] == "approve":
                    break
                if d["decision"] == "take_over":
                    return self._finish(cid, status, audit, "taken_over", "A person took the change over.")
                if d["decision"] == "changes" and change_rounds < MAX_CHANGE_ROUNDS:
                    change_rounds += 1
                    self._update_change(cid, lambda c: c.update({"corrections": c["corrections"] + 1}))
                    status("building")
                    ask(builder, "implementer", f"The reviewer (a person) asked for changes:\n{d.get('note') or ''}")
                    audit("implementer agent", "made the changes a person asked for")
                    continue
                return self._finish(cid, status, audit, "rejected", d.get("note") or "The diff was rejected.")

            # 4. Merge: one commit on the project's main branch.
            check()
            commit = self._merge(cid, ticket, repo)
            c = self.change(cid)
            dark = eff == "low" and c["human_steps"] == 0
            clean = c["corrections"] == 0
            note = self._update_ledger(lambda led: P.record_merge(led["areas"][ticket["area"]], dark=dark, clean=clean,
                                                                  when=now(), change_id=cid))
            status("merged", merged_at=now(), commit=commit, dark=dark)
            audit("factory", "merged" + (" with no person (ran dark)" if dark else " after a person approved"),
                  f"commit {commit[:10]}" + (f"; area {ticket['area']} {note}" if note else ""))
        except Stopped as exc:
            self._finish(cid, status, audit, "expired" if exc.reason == "expired" else "stopped", exc.message,
                         reason=exc.reason)
        except ApiError as exc:
            self._finish(cid, status, audit, "failed", exc.message)
        except Exception as exc:  # noqa: BLE001 - an API error part-way: the change still ends in a stored state
            self._finish(cid, status, audit, "failed", f"{type(exc).__name__}: {exc}"[:500])
        finally:
            stop.set()
            try:
                publish({"type": "done", "change": self.change(cid)})
            except ApiError:
                pass

    def _stop_reason(self, reason: str, message: str) -> None:
        r = self._running
        if r is not None and r.get("reason") is None:
            r["reason"], r["message"] = reason, message

    def _finish(self, cid: str, status: Callable, audit: Callable, state: str, why: str,
                reason: str | None = None) -> None:
        audit("factory", f"ended: {state.replace('_', ' ')}", why)
        status(state, stopped_reason=reason or why[:200])

    # ----- gates -----
    def _gates(self, cid: str, ticket: dict[str, Any], work: Path, repo: Path, base: str, base_tests: dict[str, int],
               base_failing: set[str], level: int, declared: str, agent: Callable, ask: Callable, publish: Callable,
               audit: Callable) -> dict[str, Any]:
        # The agent's regular files go into the factory's own repository; a .git folder, links and caches never do.
        skipped = sync_tree(work, repo)
        if skipped:
            audit("factory", "left out of the change", "; ".join(skipped[:10]))
        git(["add", "-A"], repo)
        _, diff = git(["diff", "--cached", "--no-ext-diff", "--no-textconv", base, "--", "."], repo)
        _, numstat = git(["diff", "--cached", "--numstat", "--no-ext-diff", "--no-textconv", base], repo)
        files, lines = [], 0
        for row in numstat.splitlines():
            parts = row.split("\t")
            if len(parts) == 3:
                files.append(parts[2])
                lines += sum(int(x) for x in parts[:2] if x.isdigit())
        added = "\n".join(l[1:] for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++"))
        gates: list[dict[str, Any]] = []

        def gate(name: str, passed: bool, detail: str) -> None:
            gates.append({"name": name, "passed": passed, "detail": detail})
            audit("gate", f"{name}: {'passed' if passed else 'failed'}", detail)

        # Policy checks
        gate("a change was made", bool(files), f"{len(files)} files, {lines} lines" if files else "the diff is empty")
        outside = [f for f in files if f.startswith(("/", "..")) or "/../" in f or f.startswith(".git/")]
        gate("stays inside the project", not outside, ", ".join(outside) or "every file is inside the project")
        secret = next((p for p in SECRET_PATTERNS if re.search(p, added)), None)
        gate("no secrets", secret is None, "added lines match a secret pattern" if secret else "none found")
        gate("diff size", lines <= P.MAX_DIFF_LINES, f"{lines} of at most {P.MAX_DIFF_LINES} lines")

        # Tests: they must pass, and must not have been deleted, emptied or skipped.
        code, out = self._run_tests(work)
        now_tests = test_counts(repo)
        lost = [f"{f} ({n} -> {now_tests.get(f, 0)})" for f, n in base_tests.items() if now_tests.get(f, 0) < n]
        skipped = next((p for p in SKIP_PATTERNS if re.search(p, added)), None)
        if skipped is None and re.search(r"skipped=\d+", out):
            skipped = "the test run reports skipped tests"
        failing = failures(out)
        new = sorted(failing - base_failing)
        ran = code == 0 or bool(failing)  # a non-zero exit with no failures listed means the tests did not run
        passed_tests = ran and not new
        fixed = sorted(base_failing - failing)
        self._update_change(cid, lambda c: c.update({"tests": {"passed": passed_tests, "output": out[-6000:],
                                                              "counts": now_tests, "new_failures": new,
                                                              "fixed": fixed, "still_failing": sorted(failing)}}))
        gate("tests: no new failures", passed_tests,
             ("the tests did not run: " + (out.strip().splitlines() or ["no output"])[-1][:160]) if not ran else
             (f"new failures: {', '.join(new)}" if new else
              f"{len(fixed)} fixed, {len(failing)} still failing as on main" if failing or fixed else "all pass"))
        gate("no tests deleted or skipped", not lost and not skipped,
             ("fewer tests in " + ", ".join(lost)) if lost else (f"a test is skipped ({skipped})" if skipped else
                                                                 "every test is still there and runs"))

        # Evidence from the real diff can raise the tier, never lower it.
        c = self.change(cid)
        covered = coverage(repo, files)
        ev = P.Evidence(files=files, diff_lines=lines, added=added, tests_text="", covered=covered)
        tier, more = P.raise_for_evidence(c["policy_tier"] or declared, ev)
        evidence = P.higher(c.get("evidence_tier") or "low", P.raise_for_evidence("low", ev)[0])
        eff, why = P.effective_tier(tier, level, declared=declared, evidence=evidence)
        if P.TIERS.index(eff) < P.TIERS.index(c["effective_tier"] or "low"):
            eff, why = c["effective_tier"], "the tier is never lowered during a change"
        self._update_change(cid, lambda c: c.update({"policy_tier": tier, "tier": eff, "effective_tier": eff,
                                                     "evidence_tier": evidence, "diff": diff[-120000:], "files": files, "diff_lines": lines,
                                                     "tier_reasons": [*c["tier_reasons"], *more, why]}))
        if eff != c["effective_tier"]:
            audit("policy", f"tier raised to {eff}", "; ".join(more))

        # An independent reviewer, in its own context, with a checklist.
        reviewer = agent("reviewer", "plan", work)
        text = ask(reviewer, "reviewer", REVIEW_PROMPT.format(tests=out[-3000:], diff=diff[-30000:], **ticket))
        review = parse_review(text)
        self._update_change(cid, lambda c: c.update({"review": review or {"verdict": None, "findings": [],
                                                                          "raw": text[-2000:]}}))
        gate("reviewer agent", bool(review and review["verdict"] == "pass"),
             "no verdict the factory can hold it to" if review is None else
             f"{review['verdict']}: {len(review['findings'])} findings")

        c = self._update_change(cid, lambda c: c.update({"gates": gates}))
        publish({"type": "change", "change": c})
        problems = [f"{g['name']}: {g['detail']}" for g in gates if not g["passed"]]
        if review and review["verdict"] != "pass":
            problems += [f"{f['severity']} in {f['file']}: {f['issue']}" for f in review["findings"]]
        return {"passed": all(g["passed"] for g in gates), "problems": problems, "effective": eff, "diff": diff}

    def _no_new_failures(self, a: Any, base_failing: set[str]) -> str | None:
        """The implementer's stop check: not finished while its change adds a failing test."""
        try:
            code, out = self._run_tests(a.ws.root)
        except Exception:  # noqa: BLE001 - the gates run the tests again and decide
            return None
        new = sorted(failures(out) - base_failing)
        if code != 0 and not failures(out):
            return f"The tests did not run:\n{out[-1500:]}\nFix that before you finish."
        if new:
            return f"Your change makes these tests fail: {', '.join(new)}.\n{out[-1500:]}\nYou are not finished."
        return None

    def _run_tests(self, work: Path) -> tuple[int, str]:
        try:
            return self.box().run(TEST_COMMAND, work, 300)
        except C.ToolError as exc:
            return 1, str(exc)

    def _merge(self, cid: str, ticket: dict[str, Any], repo: Path) -> str:
        """Commits the change in the factory's own clone and brings it into the project as one commit."""
        git(["add", "-A"], repo)
        git(["commit", "-qm", f"{ticket['title']} ({ticket['id']}, change {cid})"], repo)
        for args in (["fetch", "-q", str(repo), "HEAD"], ["merge", "-q", "--ff-only", "FETCH_HEAD"]):
            code, out = git(args, self.project)
            if code:
                raise ApiError(409, "merge_failed", f"The change could not be merged: {out[:300]}")
        _, sha = git(["rev-parse", "HEAD"], self.project)
        return sha

    # ----- people -----
    def _decide(self, cid: str, run: Run, publish: Callable, stop: threading.Event, kind: str,
                payload: dict[str, Any]) -> dict[str, Any]:
        """Waits for a person's decision on a plan or a diff. No answer in time is a rejection."""
        did = secrets.token_hex(8)
        waiter = {"event": threading.Event(), "answer": None, "run_id": run.id, "change_id": cid, "kind": kind}
        with self._lock:
            self._decisions[did] = waiter
        publish({"type": "decision_needed", "decision_id": did, "kind": kind,
                 "timeout_s": self.decision_timeout_s, **payload})
        end = time.monotonic() + self.decision_timeout_s
        while not waiter["event"].wait(0.5):
            if stop.is_set() or time.monotonic() > end:
                break
        with self._lock:
            self._decisions.pop(did, None)
        answer = waiter["answer"]
        if answer is None:
            if stop.is_set():
                r = self._running or {}
                raise Stopped(r.get("reason") or "stopped", r.get("message") or "Stopped.")
            raise Stopped("expired", f"No person answered within {self.decision_timeout_s} s, so the {kind} was not "
                                     "approved.")
        publish({"type": "decision_done", "decision_id": did, "decision": answer["decision"]})
        return answer

    def _person(self, cid: str, d: dict[str, Any], audit: Callable) -> None:
        self._update_change(cid, lambda c: c.update({"human_steps": c["human_steps"] + 1}))
        audit("person", f"{d['kind']}: {d['decision'].replace('_', ' ')}", d.get("note") or "")
        if d["decision"] in ("reject", "changes", "take_over"):
            area = self.change(cid)["area"]
            self._update_ledger(lambda led: P.record_override(led["areas"][area], when=now(), change_id=cid,
                                                              what=d["decision"]))

    def decide(self, run_id: str, decision_id: str, decision: str, note: str = "", plan: str | None = None) -> None:
        if decision not in ("approve", "reject", "changes", "take_over"):
            raise ApiError(400, "invalid_request", "decision is approve, reject, changes or take_over.")
        with self._lock:
            waiter = self._decisions.get(decision_id)
            if waiter is None or waiter["run_id"] != run_id or waiter["answer"] is not None:
                raise ApiError(404, "not_found", "That decision is no longer waiting.")
            if decision == "changes" and waiter["kind"] != "diff":
                raise ApiError(400, "invalid_request", "Ask for changes to a diff; edit the plan instead.")
            if decision in ("reject", "changes") and not (note or "").strip():
                raise ApiError(400, "invalid_request", "Say why, so the agent and the audit trail know.")
            waiter["answer"] = {"decision": decision, "kind": waiter["kind"], "note": (note or "").strip()[:2000],
                                "plan": (plan or "")[:8000] if waiter["kind"] == "plan" else None}
            del self._decisions[decision_id]  # only the first answer counts
        waiter["event"].set()

    def stop(self, run_id: str) -> None:
        r = self._running
        if r is None or r["run_id"] != run_id:
            raise ApiError(404, "not_found", "That change is not running.")
        self._stop_reason("stopped", "Stopped by the person.")
        r["stop"].set()

    def revert(self, change_id: str, note: str = "") -> dict[str, Any]:
        """A merged change was wrong: revert its commit and record an escaped defect against its area."""
        if not self._busy.acquire(blocking=False):
            raise ApiError(409, "busy", "A change is running. Revert when it has finished.")
        try:
            c = self.change(change_id)
            if c["status"] != "merged" or not c.get("commit"):
                raise ApiError(400, "invalid_request", "Only a merged change can be reverted.")
            code, out = git(["revert", "--no-edit", c["commit"]], self.project)
            if code:
                git(["revert", "--abort"], self.project)
                raise ApiError(409, "revert_failed", f"The change could not be reverted cleanly: {out[:300]}")
            note_level = self._update_ledger(lambda led: P.record_escape(led["areas"][c["area"]], when=now(),
                                                                       change_id=change_id, reverted=True))
            entry = {"at": now(), "actor": "person", "what": "reverted: an escaped defect",
                     "why": ((note or "").strip()[:500] + f" (area {c['area']} {note_level})").strip()}
            return self._update_change(change_id, lambda x: (x.update({"status": "reverted"}), x["audit"].append(entry)))
        finally:
            self._busy.release()

    def reset(self) -> None:
        """Starts again: a fresh copy of the practice project, no changes, a new track record."""
        if not self._busy.acquire(blocking=False):
            raise ApiError(409, "busy", "A change is running. Reset when it has finished.")
        try:
            shutil.rmtree(self.folder, ignore_errors=True)
        finally:
            self._busy.release()

    # ----- real agents -----
    def _real_agent(self, role: str, model: str, root: Path, mode: str, effort: str, emit: Callable) -> Any:
        """The lab's coding agent, read-only for the planner and the reviewer and in the sandbox for the implementer.
        Every model call is charged to the lab's spend."""
        a = C.CodingAgent(self.claude.client, model, root, mode=mode, effort=effort, emit=emit,
                          approve=lambda *_: False, on_response=lambda resp: self.spend.charge(resp, model))
        if C.is_gpt(model) and self.gpt is not None:
            a.gpt_client = self.gpt.client()
        return a


def test_counts(root: Path) -> dict[str, int]:
    """Test functions per test file, to notice tests that disappear."""
    out = {}
    for p in sorted(root.rglob("test_*.py")):
        if ".git" in p.parts or "__pycache__" in p.parts:
            continue
        try:
            out[p.relative_to(root).as_posix()] = count_tests(p.read_text(encoding="utf-8"))
        except OSError:
            continue
    return out


def coverage(root: Path, files: list[str]) -> dict[str, bool]:
    """For each changed source file, whether a test mentions its module or one of its functions."""
    tests = "\n".join(p.read_text(encoding="utf-8", errors="ignore") for p in root.rglob("test_*.py")
                      if ".git" not in p.parts)
    out = {}
    for f in files:
        if not f.endswith(".py") or P.is_test(f):
            continue
        path = root / f
        names = {Path(f).stem}
        if path.exists():
            names |= set(re.findall(r"^def (\w+)", path.read_text(encoding="utf-8", errors="ignore"), re.M))
        out[f] = any(re.search(rf"\b{re.escape(n)}\b", tests) for n in names if n != "__init__")
    return out


def metrics(changes: list[dict[str, Any]], areas: dict[str, Any]) -> dict[str, Any]:
    merged = [c for c in changes if c["status"] in ("merged", "reverted") and c.get("merged_at")]
    finished = [c for c in changes if c["status"] in FINISHED]
    leads = sorted((datetime.fromisoformat(c["merged_at"]) - datetime.fromisoformat(c["created_at"])).total_seconds()
                   for c in merged)
    return {"merged": len(merged), "dark": sum(1 for c in merged if c.get("dark")),
            "dark_share": round(sum(1 for c in merged if c.get("dark")) / len(merged), 3) if merged else 0.0,
            "interventions": sum(c.get("human_steps", 0) for c in changes),
            "escapes": sum(a.get("escapes", 0) for a in areas.values()),
            "lead_time_s": leads[len(leads) // 2] if leads else None,
            "cost_per_change_usd": round(sum(c.get("cost_usd", 0) for c in finished) / len(finished), 4)
            if finished else None,
            "blocked": sum(1 for c in changes if c["status"] == "blocked")}
