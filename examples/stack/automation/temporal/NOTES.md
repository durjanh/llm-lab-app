# Temporal

Temporal is a code-first durable execution engine. A workflow is ordinary Python that Temporal records and can replay,
so it survives crashes and restarts. Anything that touches the outside world (a model call, an HTTP request) is an
activity, and each activity carries a retry policy.

## How it does this task

- `workflows.py` holds `TriageWorkflow` and three activities (`classify`, `draft_reply`, `log_to_crm`).
- The branch is plain Python in the workflow (`shared.route`). It is deterministic, so it is safe to replay. The model
  calls are activities because they are not.
- Every activity runs with `RetryPolicy(initial_interval=200ms, backoff_coefficient=2, maximum_attempts=4)`.
- `log_to_crm` is the flaky step. It fails when `activity.info().attempt == 1`. Temporal numbers the attempts, so the
  activity needs no counter of its own, and the attempt that succeeded is what the workflow returns.
- `run.py` starts the local dev server with `WorkflowEnvironment.start_local()`. The first run downloads the server
  binary (the `temporal` CLI is not needed). No Docker, no account.

## Limits and notes

- The workflow code runs in a sandbox that re-imports the module. That is why the workflow lives in `workflows.py`:
  importing the file that also builds paths and loads `.env` failed the sandbox's checks. `shared` is passed through
  with `workflow.unsafe.imports_passed_through()`.
- Activities here are synchronous functions run in a thread pool. Async activities would suit a high call volume better.
- Temporal is the heaviest to learn of the code-first tools, and the most robust: the same workflow could run for days
  with human approval steps and timers, which Airflow and Prefect do not do as naturally.
- The dev server is in memory, so nothing is kept after the run.

Ran on 2026-11-15: PASS, e1 escalated, e4 dropped, 3 drafts, the flaky step succeeded on attempt 2 (about 12 s).
