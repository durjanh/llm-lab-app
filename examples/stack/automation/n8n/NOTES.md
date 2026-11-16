# n8n

n8n is a low-code workflow tool: you wire nodes together on a canvas, and the workflow is stored as JSON. It can be
self-hosted. This example uses n8n 2.47.7 from `docker.n8n.io/n8nio/n8n` (about 1.95 GB on disk).

## How it does this task

- `workflow.json` is the workflow (written by `build_workflow.py` from the shared prompts and emails). Nodes: Manual
  Trigger, a Code node with the five emails, an HTTP Request node that calls the Anthropic Messages API, a Code node
  that parses the JSON, a Switch node (drop, escalate, reply fallback), a second HTTP Request node for the draft,
  a Merge node, a Code node that collects the records, an HTTP Request to the CRM, and a final Code node.
- The key is `{{ $env.ANTHROPIC_API_KEY }}` in a header. The container gets the variable from the host environment when
  `run.py` starts it (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false` lets nodes read it). It is never in `workflow.json`. Using an
  n8n credential would also work but needs the credential created in the database first.
- Retry is a node setting: `retryOnFail`, `maxTries: 3`, `waitBetweenTries: 1000`, on every HTTP Request node.
- The flaky step is the "Log to CRM" HTTP Request node. It calls a small second container (`crm`) that returns 503 on
  its first request and 200 after.
- `run.py` copies the workflow in, runs `n8n import:workflow`, then `n8n execute --id=... --rawOutput` inside the
  container and reads the `Final` node's output from the execution JSON the CLI prints. Then `docker compose down -v`.

## Limits and notes

- A Code node cannot keep state across its own retries. I first tried `$getWorkflowStaticData` for the flaky step and the
  count was lost when the node threw (Code nodes run in a task runner in n8n 2.x). Hence the separate CRM container.
- `n8n execute` starts a second n8n process in the container, which clashes with the running server's task broker port,
  so the exec sets `N8N_RUNNERS_BROKER_PORT=5680`.
- The CRM container uses the n8n image's own Node, so no second image is pulled.
- `execute` runs the Manual Trigger once. For a live trigger you would use a Webhook node and activate the workflow.
- The Python task runner prints "Failed to start Python task runner" in the log. It is not used here (Code nodes are JS).
- The workflow is the least readable of the code-first and low-code options as text: expressions inside JSON strings.

Ran on 2026-11-15: PASS, e1 escalated, e4 dropped, 3 drafts, the CRM node succeeded on attempt 2 (20 to 70 s; the first run was slower).
