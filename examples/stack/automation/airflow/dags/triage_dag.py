"""Airflow DAG: classify, branch, draft or escalate or drop, save, and a flaky step with task retries.

TaskFlow tasks pass the batch to each other through XCom. The branch task returns the ids of the tasks to run, and
the others are skipped.
"""
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # automation, for shared.py
import shared  # noqa: E402

from airflow.sdk import dag, get_current_context, task  # noqa: E402


@dag(dag_id="triage", schedule=None, start_date=datetime(2026, 1, 1), catchup=False,
     default_args={"retries": 2, "retry_delay": timedelta(seconds=1)})
def triage():
    @task
    def classify_all() -> list[dict]:
        return [{**e, **shared.classify(e)} for e in shared.EMAILS]

    @task.branch
    def branch(items: list[dict]) -> list[str]:
        actions = {shared.route(i) for i in items}
        return [name for action, name in (("escalate", "escalate_urgent"), ("drop", "drop_spam"),
                                          ("reply", "draft_replies")) if action in actions]

    @task
    def escalate_urgent(items: list[dict]) -> list[dict]:
        return [shared.record(i, i, "escalate") for i in items if shared.route(i) == "escalate"]

    @task
    def drop_spam(items: list[dict]) -> list[dict]:
        return [shared.record(i, i, "drop") for i in items if shared.route(i) == "drop"]

    @task
    def draft_replies(items: list[dict]) -> list[dict]:
        return [shared.record(i, i, "reply", shared.draft_reply(i)) for i in items if shared.route(i) == "reply"]

    @task(trigger_rule="none_failed_min_one_success", retries=3)
    def save_and_log(escalated, dropped, drafted) -> dict:
        """Flaky on purpose. Airflow numbers task attempts, so try_number is the attempt."""
        results = sorted([*(escalated or []), *(dropped or []), *(drafted or [])], key=lambda r: r["id"])
        attempt = get_current_context()["ti"].try_number
        if attempt == 1:
            raise RuntimeError("CRM unavailable (deliberate first-call failure)")
        path = shared.write_results(Path(os.environ["STACK_OUT"]), results, attempt)
        return {"path": str(path), "attempt": attempt}

    items = classify_all()
    chosen = branch(items)
    esc, drop, draft = escalate_urgent(items), drop_spam(items), draft_replies(items)
    chosen >> [esc, drop, draft]
    save_and_log(esc, drop, draft)


triage()
