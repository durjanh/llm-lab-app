"""n8n in Docker: import workflow.json with the n8n CLI, run it with `n8n execute`, and read the result back.

The key reaches the workflow as an environment variable of the container (passed through from this process),
so it is never written into workflow.json or any file.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))  # examples/stack
sys.path.insert(0, str(HERE.parent))  # automation
from common import checks  # noqa: E402

import shared  # noqa: E402

NAME = "automation/n8n"
WORKFLOW_ID = "stacktriage0001"
ENV = {**os.environ, "ANTHROPIC_API_KEY": shared.config.env("ANTHROPIC_API_KEY"), "STACK_CLAUDE_MODEL": shared.MODEL}


def compose(*args: str, check: bool = True, timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", "compose", *args], cwd=HERE, env=ENV, capture_output=True, text=True,
                          check=check, timeout=timeout)


def main() -> None:
    compose("down", "-v", check=False)
    try:
        compose("up", "-d")
        for _ in range(60):
            try:
                urllib.request.urlopen("http://127.0.0.1:18801/healthz/readiness", timeout=2)
                break
            except OSError:
                time.sleep(2)
        compose("cp", "workflow.json", "n8n:/tmp/workflow.json")
        for _ in range(10):  # the server can answer /healthz a moment before its database is ready for the CLI
            imported = compose("exec", "-T", "n8n", "n8n", "import:workflow", "--input=/tmp/workflow.json", check=False)
            if imported.returncode == 0:
                break
            time.sleep(3)
        else:
            print((imported.stdout + imported.stderr)[-1500:])
            checks.report(NAME, False, "n8n import:workflow failed")
            return
        # The server holds the task-broker port, so the CLI run gets its own.
        run = compose("exec", "-T", "-e", "N8N_RUNNERS_BROKER_PORT=5680", "n8n", "n8n", "execute",
                      f"--id={WORKFLOW_ID}", "--rawOutput", check=False)
        final = None
        marker = run.stdout.find("\n{\n")  # the execution JSON starts on a line of its own, after the log lines
        if marker >= 0:
            data, _ = json.JSONDecoder().raw_decode(run.stdout[marker + 1:])
            runs = data.get("data", {}).get("resultData", {}).get("runData", {}).get("Final")
            if runs:
                final = runs[-1]["data"]["main"][0][0]["json"]
        if not final:
            print((run.stdout + run.stderr)[-2000:])
            checks.report(NAME, False, "no result from the Final node")
            return
        path = shared.write_results(shared.output_dir("n8n"), final["results"], final["flaky_attempts"])
        ok, detail = shared.check(final["results"], final["flaky_attempts"])
        print("results:", path)
        checks.report(NAME, ok, detail)
    finally:
        compose("down", "-v", check=False)


if __name__ == "__main__":
    if not shared.need_key():
        checks.skip(NAME, "set ANTHROPIC_API_KEY")
    elif subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
        checks.skip(NAME, "start Docker")
    else:
        main()
