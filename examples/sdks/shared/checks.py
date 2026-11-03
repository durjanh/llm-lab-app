"""Pass or fail for each task, printed in the same format by every SDK example."""
from __future__ import annotations

import re
import time

from .engagements import WRITES

_start = time.time()


def report(task: str, ok: bool, detail: str = "") -> bool:
    print(f"\n{'PASS' if ok else 'FAIL'} {task} ({time.time() - _start:.1f}s){': ' + detail if detail else ''}")
    return ok


def triage_ok(t) -> bool:
    return report("01_structured", getattr(t, "category", None) == "repairs" and getattr(t, "urgency", None) == "high",
                  f"category={getattr(t, 'category', None)}, urgency={getattr(t, 'urgency', None)}")


def answer_ok(task: str, text: str) -> bool:
    return report(task, "ENG-101" in text and bool(re.search(r"53(\.3)?\s?%", text)), "mentions ENG-101 and 53.3%")


def agent_ok() -> bool:
    good = len(WRITES) == 1 and WRITES[0]["engagement_id"] == "ENG-107" and WRITES[0]["severity"] == "medium" \
        and "Eleni" in WRITES[0]["owner"]
    return report("04_agent", good, f"writes={[(w['engagement_id'], w['severity'], w['owner']) for w in WRITES]}")


def update_ok(text: str) -> bool:
    return report("05_multi_agent", "Northgate" in text and bool(re.search(r"53|96,?000|£96", text)),
                  "mentions Northgate and the budget used")


def approve(name: str, args: dict, auto: bool) -> bool:
    """The human-in-the-loop gate every SDK's harness calls before a write tool runs."""
    print(f"\n  APPROVAL NEEDED: {name}({args})")
    if auto:
        print("  (auto-approved)")
        return True
    return input("  Allow it? [y/N] ").strip().lower() == "y"
