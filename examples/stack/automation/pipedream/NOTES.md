# Pipedream

Pipedream is a hosted automation platform for developers: a workflow is a trigger plus steps, and a step can be
real Node.js (or Python) code with any npm package. Steps are components, so they can be kept in files and published.

## How it does this task

- `triage.js` is a Node.js step using the Anthropic SDK (`@anthropic-ai/sdk`, 1.8.0). It loops over
  `steps.trigger.event.body.emails`, classifies each, branches in plain JavaScript and drafts replies.
- `log_to_crm.js` is the second step. It is the flaky step: it fails on the first run and calls
  `$.flow.rerun(1000, null, 3)`, Pipedream's way of running a step again, using `$.context.run.runs` as the attempt
  number. It then sends the HTTP response with `$.respond`.
- Workflow set-up on Pipedream: an **HTTP / Webhook** trigger with "Return a custom response" chosen, then the two steps.
  Add `ANTHROPIC_API_KEY` as a project environment variable. Copy the trigger URL into `PIPEDREAM_WEBHOOK_URL`.
- `run.py` with `PIPEDREAM_WEBHOOK_URL` set POSTs `{emails: [...]}` and runs the full shared check on the response.

## What was actually run

**Only the local run.** Without `PIPEDREAM_WEBHOOK_URL`, `run.py` runs `local.js` with Node. It imports the two step
files and calls them with a fake `$` (`export`, `respond`, `context.run.runs`, and a `flow.rerun` that runs the step
again). The Claude calls are real. So it proves the step code works, including the classification, branching and the
retry logic. **The hosted part was not run**: no Pipedream account was used, so the trigger, environment variable
handling, `$.respond` and `$.flow.rerun` on the real platform are untested. The result line says "hosted Pipedream
workflow not run".

## Limits and notes

- The fake `$.flow.rerun` is mine, written from Pipedream's documented behaviour. If the platform differs, the retry
  step is where it would show.
- Pipedream also has a step setting "Auto-retry on errors" (exponential back-off). It is a platform feature and cannot
  run locally, so the example uses `$.flow.rerun`, which can be imitated.
- `emails.js` is regenerated from `../shared.py` by `run.py`.
- `npm install` runs on the first call (it needs the network). `node_modules` is ignored by git.

Ran on 2026-11-15: PASS (local node run only), e1 escalated, e4 dropped, 3 drafts, flaky step succeeded on attempt 2.
