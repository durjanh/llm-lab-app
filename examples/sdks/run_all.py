"""Runs every SDK's five tasks with that SDK's own virtual environment, and writes RESULTS.md.

    python examples/sdks/run_all.py                 # every SDK folder that has a .venv
    python examples/sdks/run_all.py langgraph crewai
"""
from __future__ import annotations

import re
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
TASKS = ["01_structured", "02_tools", "03_mcp", "04_agent", "05_multi_agent"]
ORDER = ["openai", "openai-agents", "claude", "agent-framework", "semantic-kernel", "autogen", "langchain", "langgraph", "crewai", "strands", "pydantic-ai"]


def run(sdk: Path, task: str) -> tuple[str, float]:
    script = sdk / f"{task}.py"
    if not script.exists():
        return "—", 0.0
    args = [str(sdk / ".venv" / "bin" / "python"), str(script)] + (["--auto-approve"] if task == "04_agent" else [])
    start = time.time()
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=300, cwd=HERE.parents[1])
        text = out.stdout + out.stderr
    except subprocess.TimeoutExpired:
        return "TIMEOUT", time.time() - start
    found = re.findall(r"^(PASS|FAIL) " + task, text, flags=re.M)
    result = found[-1] if found else "ERROR"
    if result != "PASS":  # keep the whole output of a failure, to see what the model did
        (HERE / "logs").mkdir(exist_ok=True)
        (HERE / "logs" / f"{sdk.name}-{task}.log").write_text(text)
    return result, time.time() - start


def main() -> None:
    wanted = sys.argv[1:] or [d.name for d in sorted(HERE.iterdir()) if (d / ".venv").exists()]
    sdks = sorted(wanted, key=lambda n: ORDER.index(n) if n in ORDER else 99)
    results = HERE / "RESULTS.md"
    old = {}  # rows of SDKs not run this time stay as they were
    if results.exists():
        for line in results.read_text().splitlines():
            cells = [c.strip() for c in line.strip("|").split("|")]
            if line.startswith("| ") and len(cells) == len(TASKS) + 1 and cells[0] != "SDK":
                old[cells[0]] = line
    rows = []
    for name in sdks:
        cells = []
        for task in TASKS:
            result, secs = run(HERE / name, task)
            cells.append(f"{result} {secs:.0f}s" if result not in ("—",) else result)
            print(f"{name:16} {task:15} {result:7} {secs:5.1f}s", flush=True)
        old[name] = f"| {name} | " + " | ".join(cells) + " |"
    rows = [old[n] for n in sorted(old, key=lambda n: ORDER.index(n) if n in ORDER else 99)]
    table = "| SDK | " + " | ".join(TASKS) + " |\n|---|" + "---|" * len(TASKS) + "\n" + "\n".join(rows)
    (HERE / "RESULTS.md").write_text(f"# Results\n\nRun on {date.today().isoformat()} with `run_all.py` (task 4 with `--auto-approve`).\n\n{table}\n")
    print(f"\nWrote {HERE / 'RESULTS.md'}")


if __name__ == "__main__":
    main()
