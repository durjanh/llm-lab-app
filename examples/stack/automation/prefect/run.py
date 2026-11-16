"""Prefect 3: the triage workflow as a flow of tasks with retries and plain Python branching.

Runs with Prefect's ephemeral API (a temporary PREFECT_HOME, no server, no account).
"""
import os
import sys
import tempfile
from pathlib import Path

os.environ["PREFECT_HOME"] = tempfile.mkdtemp(prefix="stack-prefect-home-")  # keeps ~/.prefect untouched
os.environ.setdefault("PREFECT_LOGGING_LEVEL", "WARNING")
os.environ.setdefault("PREFECT_SERVER_EPHEMERAL_STARTUP_TIMEOUT_SECONDS", "180")  # first start runs the DB migrations
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # automation
from common import checks  # noqa: E402

import shared  # noqa: E402

NAME = "automation/prefect"


def build():
    from prefect import flow, task
    from prefect.runtime import task_run

    @task(retries=2, retry_delay_seconds=1)
    def classify(email: dict) -> dict:
        return shared.classify(email)

    @task(retries=2, retry_delay_seconds=1)
    def draft(email: dict) -> str:
        return shared.draft_reply(email)

    @task(retries=3, retry_delay_seconds=1)
    def log_to_crm(results: list[dict]) -> int:
        """Flaky on purpose. Prefect counts runs of the task, so run_count is the attempt number."""
        attempt = task_run.run_count
        if attempt == 1:
            raise RuntimeError("CRM unavailable (deliberate first-call failure)")
        return attempt

    @flow(name="triage")
    def triage(emails: list[dict]) -> dict:
        results = []
        for e in emails:
            c = classify(e)
            action = shared.route(c)  # ordinary if/else is the branching
            results.append(shared.record(e, c, action, draft(e) if action == "reply" else ""))
        return {"results": results, "flaky_attempts": log_to_crm(results)}

    return triage


def main() -> None:
    out = build()(shared.EMAILS)
    path = shared.write_results(shared.output_dir("prefect"), out["results"], out["flaky_attempts"])
    ok, detail = shared.check(out["results"], out["flaky_attempts"])
    print("results:", path)
    checks.report(NAME, ok, detail)


if __name__ == "__main__":
    if not shared.need_key():
        checks.skip(NAME, "set ANTHROPIC_API_KEY")
    else:
        main()
