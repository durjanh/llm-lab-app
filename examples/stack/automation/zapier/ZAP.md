# The Zap: Email triage

A Zap runs once per trigger event, so it handles one email at a time. The five emails arrive as five webhook calls.

| Step | App and event | What it does |
|---|---|---|
| 1 | Webhooks by Zapier: Catch Hook | Receives `{id, from, subject, body}`. Copy its URL into `ZAPIER_WEBHOOK_URL`. |
| 2 | Code by Zapier: Run Python | `code_step_classify.py`. Calls Claude, returns `category`, `urgency` and `route`. |
| 3 | Paths by Zapier | Path A: `route` is `escalate` -> Webhooks by Zapier: POST to the on-call URL (the escalation record). Path B: `route` is `drop` -> no steps, the Zap ends (spam dropped). Path C: `route` is `reply` -> steps 4 and 5. |
| 4 | Code by Zapier: Run Python | `code_step_draft.py`. Calls Claude, returns `reply`. |
| 5 | Webhooks by Zapier: POST | Sends the draft to the results URL (a CRM, a sheet, an email step). This is the step that fails once in the demo. |

Retry: Zapier has no per-step retry count. Turn on Autoreplay in the Zap's settings, and a step that errors (a 5xx from
the CRM, say) is replayed automatically a few times over a longer period. A failed run can also be replayed by hand in
Zap history.

The key: add it as the `api_key` input of each Code step. Zapier keeps it with the Zap, so use a key made for this and
limit its spend. Do not paste it anywhere else.
