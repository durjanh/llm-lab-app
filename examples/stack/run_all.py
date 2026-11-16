"""Runs every AI stack example with its own virtual environment, and writes RESULTS.md.

    python examples/stack/run_all.py                    # every tool folder that has a .venv
    python examples/stack/run_all.py vector-dbs         # one area
    python examples/stack/run_all.py memory/mem0 rag/dspy

A tool folder is examples/stack/<area>/<tool>/ with run.py and a .venv. Its last line is PASS, FAIL or SKIP (see
common/checks.py). Rows for tools not run this time are kept as they were.
"""
from __future__ import annotations

import re
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LINE = re.compile(r"^(PASS|FAIL|SKIP) ([\w.-]+/[\w.-]+)(?: \([\d.]+s\))?:?\s?(.*)$", re.M)


def tools() -> list[str]:
    return sorted(f"{p.parent.parent.name}/{p.parent.name}" for p in HERE.glob("*/*/run.py"))


def run(name: str) -> tuple[str, float, str]:
    folder = HERE / name
    python = folder / ".venv" / "bin" / "python"
    if not python.exists():
        return "NO VENV", 0.0, f"python3.12 -m venv {folder.relative_to(ROOT)}/.venv, then install requirements.txt"
    start = time.time()
    try:
        out = subprocess.run([str(python), str(folder / "run.py")], capture_output=True, text=True, timeout=900, cwd=ROOT)
        text = out.stdout + out.stderr
    except subprocess.TimeoutExpired:
        return "TIMEOUT", time.time() - start, ""
    found = [m for m in LINE.finditer(text) if m.group(2) == name]
    if not found:
        (HERE / "logs").mkdir(exist_ok=True)
        (HERE / "logs" / f"{name.replace('/', '-')}.log").write_text(text)
        return "ERROR", time.time() - start, f"see examples/stack/logs/{name.replace('/', '-')}.log"
    m = found[-1]
    return m.group(1), time.time() - start, m.group(3).strip().replace("|", "/")


def main() -> None:
    every = tools()
    args = sys.argv[1:]
    unknown = [a for a in args if a not in every and a not in {t.split("/")[0] for t in every}]
    if unknown:  # a typo must not run nothing and still rewrite RESULTS.md
        sys.exit(f"Unknown area or tool: {', '.join(unknown)}. Choose from: {', '.join(every)}")
    # With no arguments, only the tools whose environment exists; name one to be told how to make its environment.
    wanted = [t for t in every if (t in args or t.split("/")[0] in args) or (not args and (HERE / t / ".venv").exists())]
    results = HERE / "RESULTS.md"
    rows: dict[str, str] = {}
    if results.exists():
        for line in results.read_text().splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if line.startswith("| ") and len(cells) == 5 and cells[0] not in ("Area", "---"):
                rows[f"{cells[0]}/{cells[1]}"] = line
    for name in wanted:
        result, secs, detail = run(name)
        print(f"{name:32} {result:8} {secs:6.1f}s  {detail}", flush=True)
        if result == "NO VENV" and name in rows:
            continue  # not run here: keep the result recorded where its environment exists
        area, tool = name.split("/")
        rows[name] = f"| {area} | {tool} | {result} | {secs:.0f}s | {detail} |"
    body = "\n".join(rows[k] for k in sorted(rows))
    results.write_text(
        f"# Results\n\nLast run on {date.today().isoformat()} with `run_all.py`. SKIP means the tool needs something the "
        "machine does not have (an account, a key, a GPU); the detail says what. Rows not run this time are kept.\n\n"
        f"| Area | Tool | Result | Time | Detail |\n|---|---|---|---|---|\n{body}\n")
    print(f"\nWrote {results}")


if __name__ == "__main__":
    main()
