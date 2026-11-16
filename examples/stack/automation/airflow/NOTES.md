# Apache Airflow

Airflow is a code-first orchestrator built around scheduled data pipelines. A DAG is Python that declares tasks and
the order they run in; a scheduler and workers run them. This example uses Airflow 3.2.2 with its constraints file.

## How it does this task

- `dags/triage_dag.py` uses the TaskFlow API: `@task` functions pass their return values through XCom.
- `@task.branch` returns the ids of the tasks to run (`escalate_urgent`, `drop_spam`, `draft_replies`). The rest are
  skipped. The join task uses `trigger_rule="none_failed_min_one_success"`, which is what lets it run after skipped
  branches.
- `default_args` give every task `retries=2` and a one second delay. `save_and_log` has `retries=3`.
- `save_and_log` is the flaky step. It raises when `ti.try_number == 1`, then succeeds on attempt 2 and writes
  `results.json` into the folder named by `STACK_OUT`.
- `run.py` creates a temporary `AIRFLOW_HOME` with SQLite, runs `airflow db migrate`, then `airflow dags test triage`.
  There is no scheduler and no web server.

## Limits and notes

- The branch works on the whole batch, not per email: Airflow branches between tasks, so each branch task filters the
  batch. Per-email branching would need dynamic task mapping, which is heavier than this task justifies.
- `dags test` does honour task retries, so the retry is real. It takes about a minute, mostly Airflow starting up.
- Airflow is built for scheduled batch work, not for low-latency request handling. A DAG triggered per email would
  create a DAG run each time.
- Install with the constraints file (see `requirements.txt`). Without it the dependency set does not resolve.

Ran on 2026-11-15: PASS, e1 escalated, e4 dropped, 3 drafts, the flaky step succeeded on attempt 2 (20 to 60 s).
