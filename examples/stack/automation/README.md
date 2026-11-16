# Workflow automation

One small AI workflow, built in nine automation tools, so they can be compared line for line.

## The task (`shared.py`)

Five invented customer emails go in:

| id | email | should end as |
|---|---|---|
| e1 | "Boiler broken, newborn baby" | escalation record |
| e2 | refund request for order 4471 | drafted reply |
| e3 | question about carrying over annual leave (answerable from the FAQ line) | drafted reply |
| e4 | "YOU HAVE WON 1,000,000 POUNDS" | dropped |
| e5 | complaint about a late engineer | drafted reply |

The steps are the same in every tool:

1. **Classify** each email with Claude (`claude-haiku-5-5`) into `{category, urgency}` as JSON.
2. **Branch**: high urgency becomes an escalation record, spam is dropped, the rest get a short reply drafted by Claude.
3. **Save** all the results as JSON.
4. **Retry**: a deliberately flaky "log to CRM" step fails the first time, to show how each tool retries.

`shared.check()` passes when e1 is escalated, e4 dropped, there are three drafts, and the flaky step needed a second
attempt. About ten short model calls per tool, well under a cent each run. The key is read at run time from the
lab's `.env` and is never written to any file.

## The tools

Three kinds of tool, and the differences show in the folders.

**Code-first orchestrators**: the workflow is code you write, test and version.

| Tool | Idea |
|---|---|
| `temporal/` | Durable execution. Workflow code is replayed after a crash; activities carry retry policies. Best for long-running, must-not-lose-state work. |
| `airflow/` | Scheduled DAGs of tasks (TaskFlow, `@task.branch`). Built for batch data pipelines. |
| `prefect/` | A flow is a Python function; tasks and retries are decorators. Lightest of the three. |

**Low-code, self-hostable**: a visual or declarative definition run by a server.

| Tool | Idea |
|---|---|
| `n8n/` | Canvas of nodes, stored as JSON. Docker. Code nodes when the nodes are not enough. |
| `kestra/` | Declarative YAML flows with script tasks in any language. Docker (large image). |
| `power-automate/` | Microsoft's cloud flows (Logic Apps definition language). Needs a licence. Includes Copilot Studio agent flows notes (AB-100). |

**Hosted SaaS**: the workflow lives in the vendor's account.

| Tool | Idea |
|---|---|
| `zapier/` | Zaps: trigger, Code by Zapier steps, Paths. One event per run. |
| `make/` | Scenarios of modules with routers, exportable as blueprint JSON. |
| `pipedream/` | Developer-friendly: real Node.js steps with npm packages. |

## Results (run on 2026-11-15)

| Tool | Result | Notes |
|---|---|---|
| temporal | PASS | local dev server, flaky activity succeeded on attempt 2 |
| airflow | PASS | Airflow 3.2.2, `dags test`, SQLite, task retry on attempt 2 |
| prefect | PASS | ephemeral API, task retry on attempt 2 |
| n8n | PASS | n8n 2.47.7 in Docker, `n8n import:workflow` and `n8n execute`, node retry |
| kestra | PASS | Kestra v2.0.10 in Docker, flow uploaded through the API, task retry |
| power-automate | SKIP | needs a Power Automate licence (Microsoft 365 tenant); the definition JSON is validated |
| zapier | SKIP | set `ZAPIER_WEBHOOK_URL`; the two Code steps run against a stub |
| make | SKIP | set `MAKE_WEBHOOK_URL`; the blueprint is validated |
| pipedream | PASS | local node run of the step code only; the hosted workflow was not run |

The live table is `../RESULTS.md`.

## How to run

```sh
python examples/stack/run_all.py automation           # every tool here
python examples/stack/run_all.py automation/prefect   # one
```

Each tool has its own Python 3.12 `.venv` (`python3.12 -m venv .venv`, then `pip install -r requirements.txt`; the
Docker and SaaS tools only need the standard library, and `airflow/` needs its constraints file, see its
`requirements.txt`). Docker tools use ports 18801 (n8n), 18811 and 18812 (Kestra and its CRM) on 127.0.0.1, and run
`docker compose down -v` when they end.

## What each needs

| Tool | Needs |
|---|---|
| temporal | `ANTHROPIC_API_KEY`; network on the first run (downloads the dev server) |
| airflow | `ANTHROPIC_API_KEY`; the venv built with the constraints file |
| prefect | `ANTHROPIC_API_KEY` |
| n8n | `ANTHROPIC_API_KEY`, Docker (image about 1.95 GB, about 0.9 GB of memory, limit 1 GB) |
| kestra | `ANTHROPIC_API_KEY`, Docker (image 10.8 GB, 0.9 to 1.2 GB of memory, limit 1.5 GB) |
| power-automate | a Power Automate licence to run it; nothing to validate it |
| zapier | a Zapier account and `ZAPIER_WEBHOOK_URL` |
| make | a Make account and `MAKE_WEBHOOK_URL` |
| pipedream | Node 18+ and `ANTHROPIC_API_KEY` for the local run; a Pipedream account and `PIPEDREAM_WEBHOOK_URL` for the hosted one |

## Reading the comparison

- **Retry** is a function argument in Prefect, a policy object in Temporal, a task default in Airflow, a node setting in
  n8n, a task property in Kestra, an action policy in Power Automate and a directive or setting in Make and Zapier.
  Temporal, Airflow and Prefect number the attempts for you; in n8n and Kestra a stateful flaky step needed a small
  server, because a retried script cannot keep state of its own.
- **Branching** is `if` in Prefect and Temporal, `@task.branch` in Airflow, a Switch node in n8n, a `Switch` task in
  Kestra, Condition actions in Power Automate, a Router in Make and Paths in Zapier.
- **The hosted tools** cannot be run without an account, and two of them cannot show the flaky retry at all, because the
  vendor's servers cannot reach a flaky server on this machine. Their NOTES.md files say what was and was not run.
