# Make

Make (formerly Integromat) is a hosted low-code automation service. You build a scenario on a canvas of modules, and
a scenario can be exported and imported as a blueprint (JSON). It is more visual than Zapier and handles branching
and iteration well.

## How it does this task

`blueprint.json` (written by `build_blueprint.py` from the shared prompts) is one scenario:

1. **Custom webhook** (instant). One call is one email.
2. **HTTP, make a request** to the Anthropic Messages API (module 3). The key is a header you paste in after import
   (`PASTE_KEY_AFTER_IMPORT`), so none is in the file.
3. **Set multiple variables** (module 4): category and urgency, using `parseJSON` on the reply text.
4. **Router** with three filtered routes: spam, urgent, everything else. Each route ends in a **Webhook response**
   module, so the caller gets the outcome straight back. The reply route first calls Claude again (module 8).
5. Retry: both HTTP modules have an error handler with the **Break** directive (3 attempts, one minute apart). Break
   stores the run as an incomplete execution and Make retries it.

Responses are form-encoded (`id=..&action=reply&reply=<encodeURL(...)>`) rather than JSON, because escaping model text
inside a JSON string with Make's formula language is error-prone. `encodeURL` is safe.

`run.py` POSTs the five emails to `MAKE_WEBHOOK_URL` and runs the shared check on the answers. Without the URL it
validates the blueprint (unique module ids, the module kinds, an error handler on every HTTP module, prompts equal to
`shared.py`, no key) and prints SKIP.

## Limits and notes

- Not imported or run. I wrote the blueprint from the known blueprint shape and did not have a Make account. Module
  versions, the exact filter operators and `parseJSON` indexing (Make arrays start at 1) are the things to check first
  on import.
- The scenario must answer within about 40 seconds, so a webhook that returns a response suits one email, not a batch.
- The deliberate flaky CRM step is not in the hosted scenario (Make cannot reach a local flaky server), so the hosted
  check passes `need_retry=False` and the result line says "retry not exercised".
- Make bills by operations: each module run counts. One email costs about 6 to 8 operations.

Ran on 2026-11-15: SKIP, set MAKE_WEBHOOK_URL. The blueprint structure validated.
