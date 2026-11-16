# Prefect

Prefect is a code-first orchestrator for Python. A flow is a decorated function, tasks are decorated functions, and
retries are arguments to the decorator. Branching is ordinary `if`.

## How it does this task

- `run.py` defines the `triage` flow and three tasks. `classify` and `draft` have `retries=2`; `log_to_crm` has
  `retries=3`, all with a one second delay.
- The branch is a Python `if` on the classification (`shared.route`).
- `log_to_crm` is the flaky step. It fails when `prefect.runtime.task_run.run_count == 1`.
- Calling the flow runs it against Prefect's ephemeral API: Prefect starts a temporary server in the process, with its
  state in a temporary `PREFECT_HOME`. No server to run, no account, and `~/.prefect` is left alone.

## Limits and notes

- The first start runs database migrations and took longer than Prefect's default 20 second wait for the ephemeral
  server on this machine, so `run.py` raises `PREFECT_SERVER_EPHEMERAL_STARTUP_TIMEOUT_SECONDS` to 180. A run takes
  about 40 seconds, most of it that start-up.
- Tasks here run one after another. Prefect can run them concurrently with `.submit()`; five emails did not need it.
- Compared with Airflow, nothing needs scheduling or a DAG folder, and the flow is an ordinary function you can call and
  test. Compared with Temporal, a crashed process loses its progress unless you add result persistence.

Ran on 2026-11-15: PASS, e1 escalated, e4 dropped, 3 drafts, the flaky step succeeded on attempt 2 (20 to 40 s).
