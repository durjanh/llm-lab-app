"""The software factory's rules: how risky a change is, how much a person must see before it merges, and how an area
earns or loses autonomy. Pure functions over plain data, so the page can show the rules and the tests can pin them.

A change starts with the tier its ticket declares (by kind and area). Evidence found while the agent works (the files
its plan or diff touches, the size of the diff, new dependencies, edited tests, code no test covers) can raise the tier,
never lower it. The area's autonomy level then adjusts how much a person is involved, within bounds: a high-risk change
never merges without a person, whatever the track record.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any

TIERS = ["low", "medium", "high"]
TIER_MEANS = {
    "low": "Runs dark: the agent plans, builds and checks it, a reviewer agent passes it, and it merges with no person.",
    "medium": "The agent does the work; a person approves the diff before it merges.",
    "high": "The agent proposes a plan only; a person approves or edits it, then approves the diff, and can take over.",
}

KIND_TIER = {"docs": "low", "test": "low", "bugfix": "low", "refactor": "medium", "feature": "medium",
             "dependency": "medium", "schema": "high", "security": "high"}
AREA_TIER = {"docs": "low", "parsing": "low", "reporting": "low", "data": "medium", "dependencies": "medium",
             "payments": "high", "auth": "high", "security": "high"}
KINDS = list(KIND_TIER)
AREAS = list(AREA_TIER)

SENSITIVE_PATHS = [r"(^|/)(payments?|auth|security|secrets?|crypto|permissions?)(/|\.py$|_)", r"(^|/)migrations?/",
                   r"(^|/)schema", r"(^|/)\.github/", r"(^|/)(requirements[^/]*\.txt|setup\.py|setup\.cfg|pyproject\.toml)$"]
SENSITIVE_WORDS = [r"\bpassword\b", r"\btoken\b", r"\bsecret\b", r"\bapi[_-]?key\b", r"\beval\(", r"\bexec\(",
                   r"\bsubprocess\b", r"\bpickle\b", r"\bos\.system\b"]
DEPENDENCY_FILES = re.compile(r"(^|/)(requirements[^/]*\.txt|setup\.py|setup\.cfg|pyproject\.toml|Pipfile|poetry\.lock)$")
STDLIB_HINT = {"csv", "dataclasses", "datetime", "decimal", "collections", "typing", "pathlib", "re", "json", "math",
               "unittest", "functools", "itertools", "enum", "io", "os", "sys", "string", "statistics", "abc",
               "__future__", "ledger", "tests"}
MEDIUM_DIFF_LINES = 120  # a diff bigger than this needs a person to read it
MAX_DIFF_LINES = 400  # a gate: bigger than this is refused outright, as too big to review well

PROMOTE_AFTER = 3  # clean merged changes in a row that earn an area the next autonomy level
LEVELS = {0: "probation", 1: "standard", 2: "trusted"}
START_LEVEL = 1


def higher(a: str, b: str) -> str:
    return a if TIERS.index(a) >= TIERS.index(b) else b


def declared_tier(kind: str, area: str) -> tuple[str, list[str]]:
    """The ticket's own tier: the higher of what its kind and its area call for."""
    k, a = KIND_TIER.get(kind, "medium"), AREA_TIER.get(area, "medium")
    tier = higher(k, a)
    return tier, [f"kind {kind} is {k}", f"area {area} is {a}"]


@dataclass
class Evidence:
    """What the work showed: files touched, diff size, added lines, and the project's test files before and after."""
    files: list[str] = field(default_factory=list)
    diff_lines: int = 0
    added: str = ""  # the added lines of the diff, joined
    tests_text: str = ""  # every test file's text after the change
    covered: dict[str, bool] = field(default_factory=dict)  # a touched source file -> whether a test mentions it


def raise_for_evidence(tier: str, ev: Evidence) -> tuple[str, list[str]]:
    """Raises the tier for what the work touched. Returns the new tier and each reason; never lowers it."""
    reasons: list[str] = []

    def at_least(level: str, why: str) -> None:
        nonlocal tier
        if TIERS.index(level) > TIERS.index(tier):
            tier = level
            reasons.append(f"raised to {level}: {why}")
        else:
            reasons.append(f"{why} (already {tier})")

    for f in ev.files:
        if any(re.search(p, f) for p in SENSITIVE_PATHS):
            at_least("high", f"touches a sensitive path, {f}")
    for w in SENSITIVE_WORDS:
        if re.search(w, ev.added, re.I):
            at_least("high", f"adds code matching {w.strip(chr(92) + 'b')}")
            break
    if any(DEPENDENCY_FILES.search(f) for f in ev.files) or new_imports(ev.added):
        at_least("medium", "adds a dependency" + (f" ({', '.join(new_imports(ev.added))})" if new_imports(ev.added) else ""))
    if ev.diff_lines > MEDIUM_DIFF_LINES:
        at_least("medium", f"a diff of {ev.diff_lines} lines")
    if any(is_test(f) for f in ev.files):
        at_least("medium", "changes the tests themselves")
    uncovered = [f for f, ok in ev.covered.items() if not ok]
    if uncovered:
        at_least("medium", f"no test covers {', '.join(uncovered)}")
    return tier, reasons


def new_imports(added: str) -> list[str]:
    """Top-level modules imported by added lines that are not in the standard library or the project."""
    found = re.findall(r"^\s*(?:from\s+([A-Za-z_][\w]*)|import\s+([A-Za-z_][\w]*))", added, re.M)
    names = {a or b for a, b in found}
    return sorted(n for n in names if n and n not in STDLIB_HINT)


def is_test(path: str) -> bool:
    return PurePosixPath(path).name.startswith("test_") or "/tests/" in f"/{path}"


def effective_tier(tier: str, level: int, declared: str, evidence: str = "low") -> tuple[str, str]:
    """The tier after the area's autonomy level: probation adds a person to low-risk work, and trusted lets medium-risk
    work run dark, but only when medium is what the ticket declared and the work itself showed nothing that calls for
    medium (`evidence`: the tier the plan and diff alone call for). A tier raised by evidence is never lowered, and
    high never runs dark."""
    if level <= 0 and tier == "low":
        return "medium", "the area is on probation, so even low-risk work needs a person"
    if level >= 2 and tier == "medium":
        if declared == "medium" and evidence == "low":
            return "low", "the area is trusted, so medium-risk work may run dark"
        return "medium", "the area is trusted, but the work itself called for medium, which autonomy never lowers"
    return tier, f"the area's level ({LEVELS.get(level, level)}) leaves it at {tier}"


# ----- the track record -----

def new_area() -> dict[str, Any]:
    return {"level": START_LEVEL, "clean_streak": 0, "merged": 0, "dark": 0, "reverts": 0, "escapes": 0,
            "overrides": 0, "history": []}


def record_merge(area: dict[str, Any], *, dark: bool, clean: bool, when: str, change_id: str) -> str | None:
    """A change merged. A clean one (no person had to correct it) adds to the streak, and enough of them in a row
    earn the next level. Returns a note when the level changed."""
    area["merged"] += 1
    area["dark"] += int(dark)
    note = None
    if clean:
        area["clean_streak"] += 1
        if area["clean_streak"] >= PROMOTE_AFTER and area["level"] < max(LEVELS):
            area["level"] += 1
            area["clean_streak"] = 0
            note = f"up to {LEVELS[area['level']]} after {PROMOTE_AFTER} clean changes in a row"
    else:
        area["clean_streak"] = 0
    area["history"].append({"at": when, "change": change_id, "event": "merged", "dark": dark, "clean": clean,
                            **({"level": note} if note else {})})
    return note


def record_override(area: dict[str, Any], *, when: str, change_id: str, what: str) -> None:
    """A person corrected the agent (rejected, asked for changes, or took over): the streak starts again."""
    area["overrides"] += 1
    area["clean_streak"] = 0
    area["history"].append({"at": when, "change": change_id, "event": "override", "what": what})


def record_escape(area: dict[str, Any], *, when: str, change_id: str, reverted: bool) -> str:
    """A merged change turned out to be wrong: the area drops a level at once, and the streak starts again."""
    area["escapes"] += 1
    area["reverts"] += int(reverted)
    area["clean_streak"] = 0
    before = area["level"]
    area["level"] = max(0, area["level"] - 1)
    note = (f"down to {LEVELS[area['level']]}" if area["level"] != before else f"stays at {LEVELS[area['level']]}")
    area["history"].append({"at": when, "change": change_id, "event": "escape", "reverted": reverted, "level": note})
    return note


def rules() -> dict[str, Any]:
    """The rules as data, for the page to show exactly what the code applies."""
    return {"tiers": TIER_MEANS, "kind_tier": KIND_TIER, "area_tier": AREA_TIER,
            "sensitive_paths": SENSITIVE_PATHS, "sensitive_words": SENSITIVE_WORDS,
            "medium_diff_lines": MEDIUM_DIFF_LINES, "max_diff_lines": MAX_DIFF_LINES,
            "promote_after": PROMOTE_AFTER, "levels": LEVELS, "start_level": START_LEVEL,
            "autonomy": ["Probation: low-risk work also needs a person.", "Standard: the policy's tier as it is.",
                         "Trusted: medium-risk work may run dark. High-risk work never does."],
            "raise_only": "Evidence found during the work can raise a tier, never lower it."}
