"""Runs every workflow live on Azure and saves what happened, for the /workflows page to replay at no cost.

Anything a workflow asks a person is answered yes. The recordings are real model output; re-record after changing one.

    python record.py                 # all of them
    python record.py handoff routing
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from datetime import date

import _wf

OUT = _wf.ROOT / "frontend" / "src" / "pages" / "workflows" / "recordings.json"
OWN_PYTHON = _wf.HERE / ".venv" / "bin" / "python"  # the YAML workflow's environment
MAIN_PYTHON = _wf.ROOT / ".venv" / "bin" / "python"


def prices() -> dict:
    """The lab's price list, read through its main environment, whichever one this is running in."""
    code = "import json, common; print(json.dumps(common.PRICES))"
    return json.loads(subprocess.run([str(MAIN_PYTHON), "-c", code], cwd=_wf.ROOT / "python", capture_output=True, text=True, check=True).stdout)


async def main(names: list[str]) -> None:
    _wf.load_dotenv()
    table = prices()
    for name in names or _wf.patterns():
        if name == "declarative" and sys.prefix != str(OWN_PYTHON.parents[1]):
            subprocess.run([str(OWN_PYTHON), __file__, name], check=True)
            continue
        events: list[dict] = []
        trace = _wf.Trace(emit=events.append)
        await _wf.run_pattern(name, None, trace)
        model = next(e["model"] for e in events if e["type"] == "task")
        price = table[model]
        cost = (trace.input_tokens * price["input"] + trace.output_tokens * price["output"]) / 1e6
        saved = json.loads(OUT.read_text()) if OUT.exists() else {}
        saved[name] = {"model": model, "recorded": date.today().isoformat(), "cost_usd": round(cost, 5), "events": events}
        OUT.write_text(json.dumps(saved, indent=1, ensure_ascii=False) + "\n")
        print(f"{name}: {trace.calls} calls, ${cost:.4f}, {events[-1]['ms'] / 1000:.1f}s")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
