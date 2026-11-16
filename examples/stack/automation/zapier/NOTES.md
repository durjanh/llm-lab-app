# Zapier

Zapier is a hosted, no-code automation service (SaaS). A Zap is a trigger plus steps, built in its web editor. There is
no file to deploy: the Zap lives in your account. The files here describe it and hold the code that goes in its steps.

## How it does this task

`ZAP.md` lists the steps. In short: **Webhooks by Zapier** (Catch Hook) takes one email, a **Code by Zapier** Python
step (`code_step_classify.py`) calls Claude and returns `route`, **Paths** branch on it (escalate posts to an on-call
webhook, spam ends the Zap, the rest run a second Code step, `code_step_draft.py`, then a Webhooks POST of the draft).

- A Zap handles one event per run, so `run.py` sends the five emails as five webhook calls.
- A Catch Hook answers straight away with `{"status": "success"}`. The outcomes are only visible in Zap history, or at
  wherever the last step posts. So even with `ZAPIER_WEBHOOK_URL` set, `run.py` can check only that the hook accepted
  the emails. It does not read the results back, and says so in its result line.
- Retry: Zapier has no per-step retry count. Autoreplay (a Zap setting) replays an errored step a few times over a long
  period, and a failed run can be replayed by hand. The deliberate flaky step is not exercised, since a hosted Zap
  cannot reach a flaky server on this machine.
- The key goes in each Code step's `api_key` input, which Zapier stores with the Zap. Use a key made for this.

## What was run

Without a URL, `run.py` executes both Code step files with a stub in place of `requests` (the Code by Zapier
environment provides `input_data` and `requests`, and reads `output`). That proves the code parses, runs and
routes (e1 to escalate, e4 to drop, the others to reply). It does not call Zapier or Claude.

## Limits

- Zapier's Code steps have a 1 to 10 second timeout on the free plan (longer on paid plans), so a model call can fail
  there. The two-step split keeps each call short.
- Not tested in a real Zap. No Zapier account was used.

Ran on 2026-11-15: SKIP, set ZAPIER_WEBHOOK_URL. The two Code step files ran against a stub.
