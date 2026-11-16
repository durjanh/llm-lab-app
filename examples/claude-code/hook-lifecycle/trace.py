"""Print the hook log as a timeline: which events really fired, in what order, and how far apart.

Run it from the project after a session that used dot-claude/settings.json:  python3 trace.py [.claude/hook-log.jsonl]
Events inside a turn are indented, so the shape of the lifecycle chart shows: session, then each turn, then each loop.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

LOOP = {"PreToolUse", "PermissionRequest", "PermissionDenied", "Elicitation", "ElicitationResult", "PostToolUse",
        "PostToolUseFailure", "PostToolBatch", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted"}
TURN = {"UserPromptSubmit", "UserPromptExpansion", "Stop", "StopFailure", "Notification"}


def main(path: str = ".claude/hook-log.jsonl") -> None:
    """Read the log the async logger wrote and print one indented line per event."""
    rows = []
    for line in Path(path).read_text().splitlines():
        try:  # many hooks append at once, so a line can be half-written
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict) and isinstance(row.get("t"), (int, float)) and row.get("event"):
            rows.append(row)
    rows.sort(key=lambda r: r["t"])  # async hooks can finish out of order; the start time is in the line
    if not rows:
        print("The log is empty.")
        return
    start = rows[0]["t"]
    for r in rows:
        indent = "    " if r["event"] in LOOP else "  " if r["event"] in TURN else ""
        detail = f"  ({r['detail']})" if r.get("detail") else ""
        print(f"{(r['t'] - start) * 1000:9.0f} ms  {indent}{r['event']}{detail}")
    print(f"\n{len(rows)} events, {len({r['event'] for r in rows})} kinds.")


if __name__ == "__main__":
    main(*sys.argv[1:2])
