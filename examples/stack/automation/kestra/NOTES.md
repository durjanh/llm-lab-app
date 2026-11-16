# Kestra

Kestra is a declarative orchestrator: a flow is YAML with tasks, and the server runs them. It sits between the
code-first tools and low-code ones, and it is open source (self-hosted). This example uses `kestra/kestra:v2.0.10`.
That image is 10.8 GB on disk because it bundles every plugin.

## How it does this task

- `flow.yaml` has one input (`emails`, a JSON object keyed by id) and a `Loop` task. The `Loop` runs the child tasks
  once per email, one at a time:
  1. `classify`, a Python script task. It calls Claude with `urllib` and prints `::{"outputs": ...}::`, which Kestra
     turns into task outputs (`category`, `urgency`, `route`).
  2. `route`, a `Switch` on `route`: `drop` logs the spam, `escalate` logs a WARN line with the escalation, `reply` runs
     the `draft` script task.
  3. `record`, an `OutputValues` task that builds the record. The loop's `outputs` list exposes it.
- Retry is a task property: `retry: {type: constant, interval: PT2S, maxAttempts: 3}`.
- The key is a Kestra secret. The container gets `SECRET_ANTHROPIC_API_KEY` (base64, from the host environment at run
  time) and the flow reads `{{ secret('ANTHROPIC_API_KEY') }}`. Kestra masks it in logs.
- Script tasks use the `Process` task runner, so they run inside the Kestra container using its Python 3.12. The default
  runner would start another Docker container, which needs the Docker socket.
- The last task, `log_to_crm`, POSTs the loop's outputs to a small flaky CRM container (503 on the first request, then
  200) and retries. The CRM keeps what it receives, and `run.py` reads it back from `127.0.0.1:18812`.
- `run.py` uploads the flow with `POST /api/v1/flows`, starts it with `POST /api/v1/executions/stack/triage` (multipart,
  the emails as the `emails` field), polls the execution, then `docker compose down -v`.

## Limits and notes

- Kestra 2.0 has no `ForEach`: it is now `Loop`, and each iteration runs as its own sub-execution. Older Kestra
  examples and docs use `ForEach` and `outputs.task[taskrun.value]`; those do not work here. The Pebble filter is
  `toJson`, not `json`, and the retry key is `maxAttempts`.
- The execution API did not return task outputs in this version, which is why the results come back through the CRM
  container. In real use you would write them to a database, a file or a message instead.
- Login is the throwaway `lab@example.com` / `LabLocal1234` set in `docker-compose.yml` (basic auth is required).
- Memory: the JVM heap is capped at 768 MB (`-Xmx768m`) and the container at 1.5 GB. It used 0.9 to 1.2 GB.
- Start-up takes about 20 to 40 seconds before the API answers.

Ran on 2026-11-15: PASS, e1 escalated, e4 dropped, 3 drafts, the CRM call succeeded on attempt 2 (about 30 s).
